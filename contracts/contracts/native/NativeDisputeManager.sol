// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
 * NativeDisputeManager — the native-coin twin of DisputeManager, for chains that
 * settle in their own coin (BOT Chain) rather than in an ERC-20.
 *
 * Identical rules, events and function signatures to DisputeManager, so the
 * indexer, the AI-jury runtime and the frontend ABIs all work against either one.
 * Three deliberate differences, all forced by native value:
 *
 *  1. `openDispute` is payable and requires `msg.value == bond`. There is no
 *     allowance to pull from, so the bond travels with the call and the
 *     approve-then-open two-step disappears.
 *  2. Payouts use `call{value:}` through `_send`, never `transfer`: the 2300-gas
 *     stipend of `transfer` breaks contract-account recipients, and on this chain a
 *     requester or agent may well be an ERC-4337 smart account.
 *  3. `receive()` reverts. Bonds must arrive through `openDispute` or the contract's
 *     balance would stop matching the sum of open bonds.
 *
 * The signed digest keeps the hardened form (`block.chainid`, `address(this)`,
 * disputeId, upheld), so a jury verdict is unusable on any other chain or contract
 * instance. Only Arc's older deployment verifies the narrower digest, which is why
 * the runtime picks the shape per deployment (see server/digests.js).
 */
contract NativeDisputeManager is ReentrancyGuard {
    using MessageHashUtils for bytes32;

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

    constructor(address _signer, address _treasury, address _taskRegistry) {
        require(_signer != address(0) && _treasury != address(0), "Zero address");
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

    /// Open a dispute on a settled task by staking a bond in the chain's native
    /// coin, sent with the call. The task must exist, be SETTLED, and
    /// `msg.sender`/`agent` must match its real requester/assigned agent, which
    /// closes off disputing a fabricated or mismatched task.
    function openDispute(
        bytes32 disputeId,
        bytes32 taskId,
        address agent,
        uint256 bond,
        string calldata reason
    ) external payable nonReentrant {
        require(disputes[disputeId].status == Status.NONE, "Exists");
        require(bond > 0, "No bond");
        require(msg.value == bond, "Value must equal bond");
        require(agent != address(0), "No agent");
        (, address taskRequester, , , , address assignedAgent, uint8 status, , ) = taskRegistry.tasks(taskId);
        require(status == TASK_STATUS_SETTLED, "Task not settled");
        require(taskRequester == msg.sender, "Not this task's requester");
        require(assignedAgent == agent, "Agent mismatch");
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
    /// rejected → the requester forfeits half the bond. The signature binds this
    /// chain and this contract as well as (disputeId, upheld).
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
            _send(d.requester, bond);
        } else {
            // Unfair dispute: requester forfeits 50% of the bond, 30% to the
            // agent, 20% to the treasury, 50% returned.
            uint256 toAgent = (bond * REJECT_AGENT_BPS) / 10000;
            uint256 toTreasury = (bond * REJECT_TREASURY_BPS) / 10000;
            _send(d.agent, toAgent);
            _send(treasury, toTreasury);
            _send(d.requester, bond - toAgent - toTreasury);
        }
        emit DisputeResolved(disputeId, upheld, juryNote);
    }

    function getDispute(bytes32 disputeId) external view returns (Dispute memory) {
        return disputes[disputeId];
    }

    /// Native transfer that bubbles a failure instead of swallowing it. Not
    /// `transfer()`, whose 2300-gas stipend breaks contract-account recipients.
    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        require(to != address(0), "Zero recipient");
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Native transfer failed");
    }

    /// Bonds arrive through openDispute only; stray value would break the
    /// bond accounting.
    receive() external payable {
        revert("Bond via openDispute");
    }
}
