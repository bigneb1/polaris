// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUSDCEscrow {
    function lockFunds(bytes32 taskId, address requester, uint256 amount) external;
    function refund(bytes32 taskId) external;
}

interface IAgentRegistryT {
    function onAssigned(address wallet) external;
    function onUnassigned(address wallet) external;
    function isOnline(address w) external view returns (bool);
    function getReputation(address w) external view returns (uint256);
    function slash(address wallet, address beneficiary) external returns (uint256);
}

interface IBidEngineT {
    function reopenAuction(bytes32 taskId) external;
}

/**
 * TaskRegistry (V2) — task lifecycle + on-chain metadata source.
 *
 * V2 additions:
 *  - assignAgent bumps the agent's active-task counter (AgentRegistry.onAssigned).
 *  - submitDirectTask: a requester hires a NAMED agent directly (skips the
 *    auction) — used for "hire this agent for me" and for agent-to-agent
 *    delegation. Agent must be online and meet the reputation floor.
 *  - slashOnTimeout: if an assigned agent misses the deadline, anyone can call
 *    this to refund the requester and slash the agent (deadline discipline).
 */
contract TaskRegistry {
    IUSDCEscrow public escrow;
    IAgentRegistryT public agentRegistry;
    address public owner;
    address public bidEngine;
    address public verifierBridge;

    uint256 public constant MIN_REP_TO_BID = 70;

    enum Status { OPEN, ASSIGNED, IN_PROGRESS, COMPLETED, SETTLED, CANCELLED }

    struct Task {
        bytes32 taskId;
        address requester;
        uint256 budgetUsdc;
        uint256 deadline;
        uint256 minReputation;
        address assignedAgent;
        Status status;
        uint256 createdAt;
        uint256 winningBid; // amount the assigned agent is paid on success
    }

    mapping(bytes32 => Task) public tasks;

    event TaskSubmitted(
        bytes32 indexed taskId,
        address indexed requester,
        uint256 budgetUsdc,
        uint256 deadline,
        uint256 minReputation,
        string title,
        string description,
        string rubric,
        string taskType
    );
    event TaskAssigned(bytes32 indexed taskId, address indexed agent, uint256 bidAmount);
    event TaskSettled(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event TaskCancelled(bytes32 indexed taskId);
    event TaskTimedOut(bytes32 indexed taskId, address indexed agent);
    event TaskReopened(bytes32 indexed taskId);

    modifier onlyAuthorized() {
        require(msg.sender == bidEngine || msg.sender == verifierBridge || msg.sender == owner, "Not authorized");
        _;
    }

    constructor(address _escrow, address _agentRegistry) {
        escrow = IUSDCEscrow(_escrow);
        agentRegistry = IAgentRegistryT(_agentRegistry);
        owner = msg.sender;
    }

    function setBidEngine(address _b) external {
        require(msg.sender == owner, "Only owner");
        bidEngine = _b;
    }

    function setVerifierBridge(address _v) external {
        require(msg.sender == owner, "Only owner");
        verifierBridge = _v;
    }

    function submitTask(
        bytes32 taskId,
        uint256 budgetUsdc,
        uint256 deadline,
        uint256 minReputation,
        string calldata title,
        string calldata description,
        string calldata rubric,
        string calldata taskType
    ) external {
        _lock(taskId, budgetUsdc, deadline, minReputation);
        emit TaskSubmitted(taskId, msg.sender, budgetUsdc, deadline, minReputation, title, description, rubric, taskType);
    }

    /// Hire a specific agent directly (no auction). Used for user→agent direct
    /// hire and agent→agent delegation. The agent is paid from the budget on a
    /// passing verification, exactly like an auctioned task.
    function submitDirectTask(
        bytes32 taskId,
        address agent,
        uint256 budgetUsdc,
        uint256 deadline,
        string calldata title,
        string calldata description,
        string calldata rubric,
        string calldata taskType
    ) external {
        require(agentRegistry.isOnline(agent), "Agent offline");
        require(agentRegistry.getReputation(agent) >= MIN_REP_TO_BID, "Agent reputation below 70");
        _lock(taskId, budgetUsdc, deadline, 0);
        Task storage t = tasks[taskId];
        t.assignedAgent = agent;
        t.status = Status.ASSIGNED;
        t.winningBid = budgetUsdc; // direct hire pays the full budget
        agentRegistry.onAssigned(agent);
        emit TaskSubmitted(taskId, msg.sender, budgetUsdc, deadline, 0, title, description, rubric, taskType);
        emit TaskAssigned(taskId, agent, budgetUsdc);
    }

    function _lock(bytes32 taskId, uint256 budgetUsdc, uint256 deadline, uint256 minReputation) internal {
        require(tasks[taskId].requester == address(0), "Task exists");
        require(deadline > block.timestamp, "Deadline in past");
        require(budgetUsdc > 0, "Zero budget");
        escrow.lockFunds(taskId, msg.sender, budgetUsdc);
        tasks[taskId] = Task({
            taskId: taskId,
            requester: msg.sender,
            budgetUsdc: budgetUsdc,
            deadline: deadline,
            minReputation: minReputation,
            assignedAgent: address(0),
            status: Status.OPEN,
            createdAt: block.timestamp,
            winningBid: 0
        });
    }

    function assignAgent(bytes32 taskId, address agent, uint256 bidAmount) external onlyAuthorized {
        Task storage t = tasks[taskId];
        require(t.status == Status.OPEN, "Not open");
        t.assignedAgent = agent;
        t.status = Status.ASSIGNED;
        t.winningBid = bidAmount;
        agentRegistry.onAssigned(agent);
        emit TaskAssigned(taskId, agent, bidAmount);
    }

    /// The amount the assigned agent is paid on success (winning bid). Used by
    /// the VerifierBridge to pay the agent and refund the requester the remainder.
    function winningBidOf(bytes32 taskId) external view returns (uint256) {
        return tasks[taskId].winningBid;
    }

    function markSettled(bytes32 taskId) external onlyAuthorized {
        Task storage t = tasks[taskId];
        t.status = Status.SETTLED;
        emit TaskSettled(taskId, t.assignedAgent, t.budgetUsdc);
    }

    /// Verification failed: budget was refunded + agent slashed by the bridge.
    function markFailed(bytes32 taskId) external onlyAuthorized {
        tasks[taskId].status = Status.CANCELLED;
        emit TaskCancelled(taskId);
    }

    /// Return a rejected (but not slashed) task to the market: un-assign the
    /// agent, reopen the auction, and set it OPEN again. Budget stays escrowed,
    /// so any agent can re-bid. Called by the verifier backend (owner) when a
    /// submission is rejected with retries/time remaining.
    function reopenTask(bytes32 taskId) external onlyAuthorized {
        Task storage t = tasks[taskId];
        require(t.status == Status.ASSIGNED || t.status == Status.IN_PROGRESS, "Not reopenable");
        address agent = t.assignedAgent;
        t.assignedAgent = address(0);
        t.status = Status.OPEN;
        t.winningBid = 0;
        if (agent != address(0)) agentRegistry.onUnassigned(agent);
        if (bidEngine != address(0)) IBidEngineT(bidEngine).reopenAuction(taskId);
        emit TaskReopened(taskId);
    }

    /// Requester can cancel an OPEN task and reclaim the escrowed budget.
    function cancelTask(bytes32 taskId) external {
        Task storage t = tasks[taskId];
        require(msg.sender == t.requester, "Not requester");
        require(t.status == Status.OPEN, "Not open");
        t.status = Status.CANCELLED;
        escrow.refund(taskId);
        emit TaskCancelled(taskId);
    }

    /// Deadline discipline: anyone can enforce a missed deadline on an assigned,
    /// unsettled task — refunds the requester and slashes the agent.
    function slashOnTimeout(bytes32 taskId) external {
        Task storage t = tasks[taskId];
        require(t.status == Status.ASSIGNED || t.status == Status.IN_PROGRESS, "Not in progress");
        require(block.timestamp > t.deadline, "Before deadline");
        t.status = Status.CANCELLED;
        escrow.refund(taskId);
        agentRegistry.slash(t.assignedAgent, t.requester);
        emit TaskTimedOut(taskId, t.assignedAgent);
    }
}
