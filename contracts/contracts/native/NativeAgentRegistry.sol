// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * NativeAgentRegistry — agents stake the chain's NATIVE coin as collateral and
 * build reputation. The native-value twin of AgentRegistry, used on BOT Chain
 * where the payment asset is BOT itself. Arc keeps AgentRegistry unchanged.
 *
 * Signatures, events and reputation rules are identical to AgentRegistry so the
 * event indexer, VerifierBridge, TaskRegistry and BidEngine all work against
 * either registry unchanged. Two deliberate differences:
 *
 *  1. `register` / `restake` are payable and require `msg.value == stakeAmount`
 *     (there is no allowance to pull from). The `stakeAmount` argument is kept so
 *     the ABI and the `AgentRegistered` event stay byte-compatible.
 *
 *  2. `MIN_STAKE` is a constructor parameter, not a constant. AgentRegistry hard-codes
 *     `100_000_000` — 100 units at USDC's 6 decimals. BOT has **18** decimals, where
 *     that same number is 0.0000000001 BOT, i.e. no collateral at all. Getting this
 *     wrong would make slashing meaningless, so the floor is set per deployment.
 *
 * Reputation starts at 100 and scales per honest completion (cap 1000); the market
 * floor to be considered is 70 (enforced in BidEngine). Slashing drops reputation
 * by 50 and pays 10% of stake to the wronged requester. `activeTasks` tracks
 * in-flight work: an agent can `deactivate()` and `withdrawStake()` ONLY when idle,
 * so collateral is reclaimable but never while liable for a pending task.
 */
contract NativeAgentRegistry is ReentrancyGuard {
    address public owner;
    address public verifierBridge;
    address public taskRegistry;

    /// Minimum collateral, in wei of the native coin. Set at deploy time.
    uint256 public immutable MIN_STAKE;
    uint256 public constant START_REP = 100;
    uint256 public constant MIN_REP_TO_BID = 70;
    uint256 public constant MAX_REP = 1000;

    struct Agent {
        address wallet;
        bytes32 agentId;
        uint256 stakedUsdc; // name kept for ABI/indexer compatibility; native wei here
        uint256 reputation;
        uint256 tasksCompleted;
        uint256 tasksFailed;
        uint256 activeTasks;
        bool online;
        bool registered;
    }

    mapping(address => Agent) public agents;
    mapping(bytes32 => address) public agentIdToWallet;

    event AgentRegistered(address indexed wallet, bytes32 indexed agentId, uint256 stake, string name, string capabilities);
    event AgentDeactivated(address indexed wallet);
    event AgentRestaked(address indexed wallet, uint256 amount);
    event StakeWithdrawn(address indexed wallet, uint256 amount);
    event TaskAssignedToAgent(address indexed wallet, uint256 activeTasks);
    event ReputationUpdated(address indexed wallet, uint256 newRep);
    event AgentSlashed(address indexed wallet, uint256 penalty);

    modifier onlyAuthorized() {
        require(msg.sender == verifierBridge || msg.sender == taskRegistry || msg.sender == owner, "Not authorized");
        _;
    }

    /// @param minStake minimum collateral in wei (BOT testnet is deployed with
    ///        0.02 ether == 0.02 BOT).
    constructor(uint256 minStake) {
        require(minStake > 0, "Zero min stake");
        MIN_STAKE = minStake;
        owner = msg.sender;
    }

    function setVerifierBridge(address _b) external {
        require(msg.sender == owner, "Only owner");
        require(_b != address(0), "Zero address");
        verifierBridge = _b;
    }

    function setTaskRegistry(address _t) external {
        require(msg.sender == owner, "Only owner");
        require(_t != address(0), "Zero address");
        taskRegistry = _t;
    }

    function register(
        bytes32 agentId,
        uint256 stakeAmount,
        string calldata name,
        string calldata capabilities
    ) external payable nonReentrant {
        require(!agents[msg.sender].registered, "Already registered");
        require(msg.value == stakeAmount, "Value must equal stakeAmount");
        require(stakeAmount >= MIN_STAKE, "Below min stake");
        require(agentIdToWallet[agentId] == address(0), "agentId taken");

        agents[msg.sender] = Agent({
            wallet: msg.sender,
            agentId: agentId,
            stakedUsdc: stakeAmount,
            reputation: START_REP,
            tasksCompleted: 0,
            tasksFailed: 0,
            activeTasks: 0,
            online: true,
            registered: true
        });
        agentIdToWallet[agentId] = msg.sender;
        emit AgentRegistered(msg.sender, agentId, stakeAmount, name, capabilities);
    }

    /// Go offline: stops new bids. Only allowed when entirely idle.
    function deactivate() external {
        Agent storage a = agents[msg.sender];
        require(a.registered && a.online, "Not online");
        require(a.activeTasks == 0, "Has active tasks");
        a.online = false;
        emit AgentDeactivated(msg.sender);
    }

    /// Reclaim the full stake — only when offline AND idle (no liability).
    function withdrawStake() external nonReentrant {
        Agent storage a = agents[msg.sender];
        require(a.registered && !a.online, "Deactivate first");
        require(a.activeTasks == 0, "Has active tasks");
        uint256 amount = a.stakedUsdc;
        a.stakedUsdc = 0;
        a.registered = false;
        agentIdToWallet[a.agentId] = address(0);
        if (amount > 0) _send(msg.sender, amount);
        emit StakeWithdrawn(msg.sender, amount);
    }

    /// Come back online, optionally topping up collateral with the value sent.
    function restake(uint256 additionalAmount) external payable nonReentrant {
        Agent storage a = agents[msg.sender];
        require(a.registered && !a.online, "Not offline");
        require(msg.value == additionalAmount, "Value must equal additionalAmount");
        if (additionalAmount > 0) a.stakedUsdc += additionalAmount;
        require(a.stakedUsdc >= MIN_STAKE, "Below min stake");
        a.online = true;
        emit AgentRestaked(msg.sender, a.stakedUsdc);
    }

    /// Marks an agent as having one more in-flight task (called on assignment).
    function onAssigned(address wallet) external onlyAuthorized {
        Agent storage a = agents[wallet];
        require(a.registered, "Unknown agent");
        a.activeTasks += 1;
        emit TaskAssignedToAgent(wallet, a.activeTasks);
    }

    /// A task this agent held was reopened/returned to the market — free the slot.
    function onUnassigned(address wallet) external onlyAuthorized {
        Agent storage a = agents[wallet];
        if (a.activeTasks > 0) a.activeTasks -= 1;
        emit TaskAssignedToAgent(wallet, a.activeTasks);
    }

    function recordSuccess(address wallet, uint8 score) external onlyAuthorized {
        Agent storage a = agents[wallet];
        require(a.registered, "Unknown agent");
        uint256 boost = score > 85 ? 10 : (score >= 70 ? 5 : 2);
        uint256 next = a.reputation + boost;
        a.reputation = next > MAX_REP ? MAX_REP : next;
        a.tasksCompleted += 1;
        if (a.activeTasks > 0) a.activeTasks -= 1;
        emit ReputationUpdated(wallet, a.reputation);
    }

    /// Slash 10% of stake to the wronged requester and drop reputation by 50.
    function slash(address wallet, address beneficiary) external onlyAuthorized nonReentrant returns (uint256 penalty) {
        Agent storage a = agents[wallet];
        require(a.registered, "Unknown agent");
        penalty = a.stakedUsdc / 10;
        if (penalty > 0) {
            a.stakedUsdc -= penalty;
            _send(beneficiary, penalty);
        }
        a.reputation = a.reputation > 50 ? a.reputation - 50 : 0;
        a.tasksFailed += 1;
        if (a.activeTasks > 0) a.activeTasks -= 1;
        emit AgentSlashed(wallet, penalty);
    }

    function getReputation(address wallet) external view returns (uint256) {
        return agents[wallet].reputation;
    }

    function isOnline(address wallet) external view returns (bool) {
        return agents[wallet].online;
    }

    function getStake(address wallet) external view returns (uint256) {
        return agents[wallet].stakedUsdc;
    }

    function getActiveTasks(address wallet) external view returns (uint256) {
        return agents[wallet].activeTasks;
    }

    /// Native transfer that bubbles a failure rather than swallowing it. Not
    /// `transfer()` — its 2300-gas stipend breaks contract-account recipients, and
    /// an agent wallet here may well be a smart account.
    function _send(address to, uint256 amount) private {
        require(to != address(0), "Zero recipient");
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Native transfer failed");
    }

    /// Stake arrives through register/restake only; stray value would break the
    /// stake accounting.
    receive() external payable {
        revert("Stake via register/restake");
    }
}
