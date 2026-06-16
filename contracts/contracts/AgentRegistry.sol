// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * AgentRegistry — agents stake USDC as collateral and build reputation.
 *
 * Design notes / fixes vs the build prompt + the sibling SynapseMesh project:
 *  - Metadata (name, capabilities) is emitted in AgentRegistered so the frontend
 *    can reconstruct the whole registry from logs with no database.
 *  - NO unconditional stake-withdraw path. `unstake()` only flips the agent
 *    OFFLINE (stops new bids) while the collateral stays locked, closing the
 *    "deregister to dodge a pending slash" hole found in SynapseMesh.
 *  - slash() is onlyAuthorized (VerifierBridge) and pays the penalty to the
 *    wronged requester, not a generic owner address.
 */
contract AgentRegistry is ReentrancyGuard {
    IERC20 public immutable usdc;
    address public owner;
    address public verifierBridge;

    uint256 public constant MIN_STAKE = 5_000_000; // 5 USDC (6 decimals)
    uint256 public constant START_REP = 500;
    uint256 public constant MAX_REP = 1000;

    struct Agent {
        address wallet;
        bytes32 agentId;
        uint256 stakedUsdc;
        uint256 reputation;
        uint256 tasksCompleted;
        uint256 tasksFailed;
        bool online;
        bool registered;
    }

    mapping(address => Agent) public agents;
    mapping(bytes32 => address) public agentIdToWallet;

    event AgentRegistered(address indexed wallet, bytes32 indexed agentId, uint256 stake, string name, string capabilities);
    event AgentUnstaked(address indexed wallet, uint256 amount);
    event AgentRestaked(address indexed wallet, uint256 amount);
    event ReputationUpdated(address indexed wallet, uint256 newRep);
    event AgentSlashed(address indexed wallet, uint256 penalty);

    modifier onlyAuthorized() {
        require(msg.sender == verifierBridge || msg.sender == owner, "Not authorized");
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

    function register(bytes32 agentId, uint256 stakeAmount, string calldata name, string calldata capabilities) external nonReentrant {
        require(!agents[msg.sender].registered, "Already registered");
        require(stakeAmount >= MIN_STAKE, "Below min stake");
        require(agentIdToWallet[agentId] == address(0), "agentId taken");
        require(usdc.transferFrom(msg.sender, address(this), stakeAmount), "USDC transferFrom failed");

        agents[msg.sender] = Agent({
            wallet: msg.sender,
            agentId: agentId,
            stakedUsdc: stakeAmount,
            reputation: START_REP,
            tasksCompleted: 0,
            tasksFailed: 0,
            online: true,
            registered: true
        });
        agentIdToWallet[agentId] = msg.sender;
        emit AgentRegistered(msg.sender, agentId, stakeAmount, name, capabilities);
    }

    /// Go offline: stops new bids. Collateral stays locked (no dodge path).
    function unstake() external {
        Agent storage a = agents[msg.sender];
        require(a.registered && a.online, "Not online");
        a.online = false;
        emit AgentUnstaked(msg.sender, a.stakedUsdc);
    }

    /// Come back online, optionally topping up collateral.
    function restake(uint256 additionalAmount) external nonReentrant {
        Agent storage a = agents[msg.sender];
        require(a.registered && !a.online, "Not offline");
        if (additionalAmount > 0) {
            require(usdc.transferFrom(msg.sender, address(this), additionalAmount), "USDC transferFrom failed");
            a.stakedUsdc += additionalAmount;
        }
        a.online = true;
        emit AgentRestaked(msg.sender, a.stakedUsdc);
    }

    function recordSuccess(address wallet, uint8 score) external onlyAuthorized {
        Agent storage a = agents[wallet];
        require(a.registered, "Unknown agent");
        uint256 boost = score > 85 ? 10 : (score >= 70 ? 5 : 2);
        uint256 next = a.reputation + boost;
        a.reputation = next > MAX_REP ? MAX_REP : next;
        a.tasksCompleted += 1;
        emit ReputationUpdated(wallet, a.reputation);
    }

    /// Slash 10% of stake to the wronged requester and drop reputation.
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
}
