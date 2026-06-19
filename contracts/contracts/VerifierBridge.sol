// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IUSDCEscrow {
    function release(bytes32 taskId, address agent) external;
    function releaseSplit(bytes32 taskId, address agent, uint256 agentAmount) external;
    function refund(bytes32 taskId) external;
}

interface IAgentRegistry {
    function recordSuccess(address wallet, uint8 score) external;
    function slash(address wallet, address beneficiary) external returns (uint256);
}

interface ITaskRegistry {
    function markSettled(bytes32 taskId) external;
    function markFailed(bytes32 taskId) external;
    function winningBidOf(bytes32 taskId) external view returns (uint256);
}

/**
 * VerifierBridge (V2) — turns an off-chain quality verdict into on-chain
 * settlement, and records an on-chain ATTESTATION of the deliverable.
 *
 * HONEST TRUST MODEL: scoring is performed off-chain (an LLM scores the
 * deliverable against the task rubric). The backend signs the verdict — now
 * including a keccak256 hash of the exact deliverable — with `trustedSigner`'s
 * key, and this contract verifies that ECDSA signature. This is a trusted-signer
 * oracle, NOT a hardware/TEE attestation; a signer-key compromise compromises
 * settlement. Decentralizing it (committee / ZK / TEE) is the next step.
 *
 * The stored Attestation (score, pass/fail, deliverable hash, agent, timestamp)
 * is the permanent on-chain proof of what was delivered and how it was judged.
 */
contract VerifierBridge {
    using MessageHashUtils for bytes32;

    IUSDCEscrow public escrow;
    IAgentRegistry public agentRegistry;
    ITaskRegistry public taskRegistry;
    address public trustedSigner;
    address public owner;
    uint8 public constant MIN_SCORE = 70;

    struct Attestation {
        address agent;
        bool passed;
        uint8 score;
        bytes32 deliverableHash;
        uint256 timestamp;
    }

    mapping(bytes32 => bool) public processed;
    mapping(bytes32 => Attestation) public attestations;

    event VerificationSubmitted(bytes32 indexed taskId, address indexed agent, bool passed, uint8 score, bytes32 deliverableHash);
    event TrustedSignerUpdated(address indexed signer);

    constructor(address _escrow, address _agentRegistry, address _taskRegistry, address _signer) {
        escrow = IUSDCEscrow(_escrow);
        agentRegistry = IAgentRegistry(_agentRegistry);
        taskRegistry = ITaskRegistry(_taskRegistry);
        trustedSigner = _signer;
        owner = msg.sender;
    }

    function setTrustedSigner(address _signer) external {
        require(msg.sender == owner, "Only owner");
        trustedSigner = _signer;
        emit TrustedSignerUpdated(_signer);
    }

    function submitVerification(
        bytes32 taskId,
        address agent,
        address requester,
        bool passed,
        uint8 score,
        bytes32 deliverableHash,
        bytes calldata signature
    ) external {
        require(!processed[taskId], "Already processed");

        // The signed verdict binds the score AND the exact deliverable hash.
        bytes32 digest = keccak256(abi.encodePacked(taskId, passed, score, deliverableHash)).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        processed[taskId] = true;
        attestations[taskId] = Attestation({
            agent: agent,
            passed: passed,
            score: score,
            deliverableHash: deliverableHash,
            timestamp: block.timestamp
        });
        emit VerificationSubmitted(taskId, agent, passed, score, deliverableHash);

        if (passed && score >= MIN_SCORE) {
            // Pay the agent its winning bid; the requester is refunded the rest
            // of the budget. (Falls back to full payout if no bid was recorded.)
            escrow.releaseSplit(taskId, agent, taskRegistry.winningBidOf(taskId));
            agentRegistry.recordSuccess(agent, score);
            taskRegistry.markSettled(taskId);
        } else {
            escrow.refund(taskId);
            agentRegistry.slash(agent, requester);
            taskRegistry.markFailed(taskId);
        }
    }

    function getAttestation(bytes32 taskId) external view returns (Attestation memory) {
        return attestations[taskId];
    }
}
