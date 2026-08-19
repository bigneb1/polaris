// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface ITaskRegistryDM {
    function tasks(bytes32 taskId) external view returns (
        bytes32 id, address requester, uint256 budgetUsdc, uint256 deadline,
        uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt, uint256 winningBid
    );
}

/**
 * DisputeManager — staked dispute resolution for settled tasks (Phase C).
 *
 * Even when the verifier passes a task (score ≥ 70), the requester may feel the
 * deliverable misses the brief. They open a dispute by staking a USDC bond. An
 * off-chain AI jury re-reads the original request vs the delivered work and signs
 * a verdict (the SAME trusted-signer model as VerifierBridge):
 *   - upheld   → the bond is refunded to the requester; the runtime pings the
 *                agent to rework and applies an off-chain reputation penalty.
 *   - rejected → the bond is paid to the agent. This is the anti-abuse stake: a
 *                frivolous dispute costs the complainer and compensates the agent.
 *
 * HYBRID NOTE: the bond + its resolution are on-chain here; the rework ping and
 * the reputation penalty are applied off-chain, because the live AgentRegistry
 * authorises only one settlement contract and cannot be re-wired to let this
 * contract claw back an already-paid agent's stake. The jury's reasoning is
 * emitted on-chain for a permanent, auditable record.
 */
contract DisputeManager is ReentrancyGuard {
    using MessageHashUtils for bytes32;

    IERC20 public immutable usdc;
    ITaskRegistryDM public taskRegistry;
    address public owner;
    address public trustedSigner;
    address public treasury;
    uint8 public constant TASK_STATUS_SETTLED = 4;
    // On a rejected (unfair) dispute the requester forfeits half the bond:
    // 30% compensates the agent, 20% goes to the protocol treasury, 50% is returned.
    uint256 public constant REJECT_AGENT_BPS = 3000;
    uint256 public constant REJECT_TREASURY_BPS = 2000;

    enum Status { NONE, OPEN, UPHELD, REJECTED }

    struct Dispute {
        address requester;
        address agent;
        bytes32 taskId;
        uint256 bond;
        Status status;
    }

    mapping(bytes32 => Dispute) public disputes;

    event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed taskId, address indexed requester, address agent, uint256 bond, string reason);
    event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote);
    event TrustedSignerUpdated(address indexed signer);

    constructor(address _usdc, address _signer, address _treasury, address _taskRegistry) {
        usdc = IERC20(_usdc);
        trustedSigner = _signer;
        treasury = _treasury;
        taskRegistry = ITaskRegistryDM(_taskRegistry);
        owner = msg.sender;
    }

    function setTrustedSigner(address _signer) external {
        require(msg.sender == owner, "Only owner");
        require(_signer != address(0), "Zero address");
        trustedSigner = _signer;
        emit TrustedSignerUpdated(_signer);
    }

    function setTreasury(address _treasury) external {
        require(msg.sender == owner, "Only owner");
        require(_treasury != address(0), "Zero address");
        treasury = _treasury;
    }

    function setTaskRegistry(address _t) external {
        require(msg.sender == owner, "Only owner");
        require(_t != address(0), "Zero address");
        taskRegistry = ITaskRegistryDM(_t);
    }

    /// Open a dispute on a settled task by staking a USDC bond (approve first).
    /// The task must actually exist, be SETTLED, and `msg.sender`/`agent` must
    /// match its real requester/assigned agent — closes off disputing a
    /// fabricated or mismatched task. See docs/AUDIT_REPORT.md, Security #6/8.
    function openDispute(
        bytes32 disputeId,
        bytes32 taskId,
        address agent,
        uint256 bond,
        string calldata reason
    ) external nonReentrant {
        require(disputes[disputeId].status == Status.NONE, "Exists");
        require(bond > 0, "No bond");
        require(agent != address(0), "No agent");
        (, address taskRequester, , , , address assignedAgent, uint8 status, , ) = taskRegistry.tasks(taskId);
        require(status == TASK_STATUS_SETTLED, "Task not settled");
        require(taskRequester == msg.sender, "Not this task's requester");
        require(assignedAgent == agent, "Agent mismatch");
        require(usdc.transferFrom(msg.sender, address(this), bond), "USDC transferFrom failed");
        disputes[disputeId] = Dispute({
            requester: msg.sender,
            agent: agent,
            taskId: taskId,
            bond: bond,
            status: Status.OPEN
        });
        emit DisputeOpened(disputeId, taskId, msg.sender, agent, bond, reason);
    }

    /// Resolve with a trusted-signer (AI jury) verdict. upheld → refund requester;
    /// rejected → bond to the agent. Signature binds (disputeId, upheld).
    function resolveDispute(
        bytes32 disputeId,
        bool upheld,
        string calldata juryNote,
        bytes calldata signature
    ) external nonReentrant {
        Dispute storage d = disputes[disputeId];
        require(d.status == Status.OPEN, "Not open");

        bytes32 digest = keccak256(
            abi.encodePacked(block.chainid, address(this), disputeId, upheld)
        ).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        uint256 bond = d.bond;
        d.bond = 0;
        d.status = upheld ? Status.UPHELD : Status.REJECTED;
        if (upheld) {
            // Valid dispute: full bond back to the requester.
            require(usdc.transfer(d.requester, bond), "Refund failed");
        } else {
            // Unfair/malicious dispute: requester forfeits 50% of the bond —
            // 30% to the agent, 20% to the treasury, 50% returned.
            uint256 toAgent = (bond * REJECT_AGENT_BPS) / 10000;
            uint256 toTreasury = (bond * REJECT_TREASURY_BPS) / 10000;
            require(usdc.transfer(d.agent, toAgent), "Agent payout failed");
            require(usdc.transfer(treasury, toTreasury), "Treasury payout failed");
            require(usdc.transfer(d.requester, bond - toAgent - toTreasury), "Refund failed");
        }
        emit DisputeResolved(disputeId, upheld, juryNote);
    }

    function getDispute(bytes32 disputeId) external view returns (Dispute memory) {
        return disputes[disputeId];
    }
}
