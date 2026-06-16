// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUSDCEscrow {
    function lockFunds(bytes32 taskId, address requester, uint256 amount) external;
    function refund(bytes32 taskId) external;
}

/**
 * TaskRegistry — the task lifecycle + on-chain metadata source.
 *
 * KEY FIX vs the build prompt: submitTask no longer does its own transferFrom.
 * The requester approves USDCEscrow; this contract just calls escrow.lockFunds,
 * which is the single point that pulls USDC. (The prompt pulled twice and every
 * submit reverted.)
 *
 * Task metadata (title/description/rubric/type) is emitted in TaskSubmitted so
 * the frontend reconstructs everything from logs — no off-chain database.
 */
contract TaskRegistry {
    IUSDCEscrow public escrow;
    address public owner;
    address public bidEngine;
    address public verifierBridge;

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

    modifier onlyAuthorized() {
        require(msg.sender == bidEngine || msg.sender == verifierBridge || msg.sender == owner, "Not authorized");
        _;
    }

    constructor(address _escrow) {
        escrow = IUSDCEscrow(_escrow);
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
        require(tasks[taskId].requester == address(0), "Task exists");
        require(deadline > block.timestamp, "Deadline in past");
        require(budgetUsdc > 0, "Zero budget");

        // Single funds movement: escrow pulls from the requester (who approved it).
        escrow.lockFunds(taskId, msg.sender, budgetUsdc);

        tasks[taskId] = Task({
            taskId: taskId,
            requester: msg.sender,
            budgetUsdc: budgetUsdc,
            deadline: deadline,
            minReputation: minReputation,
            assignedAgent: address(0),
            status: Status.OPEN,
            createdAt: block.timestamp
        });

        emit TaskSubmitted(taskId, msg.sender, budgetUsdc, deadline, minReputation, title, description, rubric, taskType);
    }

    function assignAgent(bytes32 taskId, address agent, uint256 bidAmount) external onlyAuthorized {
        Task storage t = tasks[taskId];
        require(t.status == Status.OPEN, "Not open");
        t.assignedAgent = agent;
        t.status = Status.ASSIGNED;
        emit TaskAssigned(taskId, agent, bidAmount);
    }

    function markSettled(bytes32 taskId) external onlyAuthorized {
        Task storage t = tasks[taskId];
        t.status = Status.SETTLED;
        emit TaskSettled(taskId, t.assignedAgent, t.budgetUsdc);
    }

    /// Verification failed: budget was refunded + agent slashed by the bridge.
    /// Marked CANCELLED so the UI does not show it as a successful settlement.
    function markFailed(bytes32 taskId) external onlyAuthorized {
        tasks[taskId].status = Status.CANCELLED;
        emit TaskCancelled(taskId);
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
}
