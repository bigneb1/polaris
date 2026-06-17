// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * AgentRegistry (V2) — agents stake USDC as collateral and build reputation.
 *
 * V2 changes:
 *  - MIN_STAKE raised to 100 USDC.
 *  - Reputation starts at 100 and scales up per honest completion (cap 1000);
 *    the market floor to be considered is MIN_REP_TO_BID = 70 (enforced in
 *    BidEngine). Slashing drops reputation by 50.
 *  - `activeTasks` tracks in-flight work. An agent can `deactivate()` and
 *    `withdrawStake()` ONLY when it has zero active tasks — so collateral can be
 *    reclaimed once idle, but never while liable for a pending task (no
 *    slash-dodging).
 *  - TaskRegistry is authorized to bump `activeTasks` on assignment; the
 *    VerifierBridge clears it on settle/slash.
 */
contract AgentRegistry is ReentrancyGuard {
    IERC20 public immutable usdc;
    address public owner;
    address public verifierBridge;
    address public taskRegistry;

    uint256 public constant MIN_STAKE = 100_000_000; // 100 USDC (6 decimals)
    uint256 public constant START_REP = 100;
    uint256 public constant MIN_REP_TO_BID = 70;
    uint256 public constant MAX_REP = 1000;

    struct Agent {
        address wallet;
        bytes32 agentId;
        uint256 stakedUsdc;
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

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        owner = msg.sender;
    }

    function setVerifierBridge(address _b) external {
        require(msg.sender == owner, "Only owner");
        verifierBridge = _b;
    }

    function setTaskRegistry(address _t) external {
        require(msg.sender == owner, "Only owner");
        taskRegistry = _t;
    }

    function register(bytes32 agentId, uint256 stakeAmount, string calldata name, string calldata capabilities) external nonReentrant {
        require(!agents[msg.sender].registered, "Already registered");
        require(stakeAmount >= MIN_STAKE, "Below min stake (100 USDC)");
        require(agentIdToWallet[agentId] == address(0), "agentId taken");
        require(usdc.transferFrom(msg.sender, address(this), stakeAmount), "USDC transferFrom failed");

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
        if (amount > 0) require(usdc.transfer(msg.sender, amount), "Withdraw failed");
        emit StakeWithdrawn(msg.sender, amount);
    }

    /// Come back online, optionally topping up collateral.
    function restake(uint256 additionalAmount) external nonReentrant {
        Agent storage a = agents[msg.sender];
        require(a.registered && !a.online, "Not offline");
        if (additionalAmount > 0) {
            require(usdc.transferFrom(msg.sender, address(this), additionalAmount), "USDC transferFrom failed");
            a.stakedUsdc += additionalAmount;
        }
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
            require(usdc.transfer(beneficiary, penalty), "Slash transfer failed");
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
}
