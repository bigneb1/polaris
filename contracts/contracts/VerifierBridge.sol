// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IUSDCEscrow {
    function release(bytes32 taskId, address agent) external;
    function refund(bytes32 taskId) external;
}

interface IAgentRegistry {
    function recordSuccess(address wallet, uint8 score) external;
    function slash(address wallet, address beneficiary) external returns (uint256);
}

interface ITaskRegistry {
    function markSettled(bytes32 taskId) external;
    function markFailed(bytes32 taskId) external;
}

/**
 * VerifierBridge — turns an off-chain quality verdict into on-chain settlement.
 *
 * HONEST TRUST MODEL: scoring is performed off-chain by the Polaris backend
 * (Claude scores the deliverable against the task rubric). The backend signs the
 * verdict with `trustedSigner`'s key and this contract verifies that ECDSA
 * signature. This is a *trusted-signer oracle*, NOT a hardware/TEE attestation —
 * a compromise of the signer key compromises settlement. Decentralizing this
 * (committee, ZK, or real TEE quote verification) is the natural next step.
 *
 * `processed[taskId]` makes settlement idempotent — a verdict can be applied once.
 */
contract VerifierBridge {
    using MessageHashUtils for bytes32;

    IUSDCEscrow public escrow;
    IAgentRegistry public agentRegistry;
    ITaskRegistry public taskRegistry;
    address public trustedSigner;
    address public owner;
    uint8 public constant MIN_SCORE = 70;

    mapping(bytes32 => bool) public processed;

    event VerificationSubmitted(bytes32 indexed taskId, address indexed agent, bool passed, uint8 score);
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
        bytes calldata signature
    ) external {
        require(!processed[taskId], "Already processed");

        bytes32 digest = keccak256(abi.encodePacked(taskId, passed, score)).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        processed[taskId] = true;
        emit VerificationSubmitted(taskId, agent, passed, score);

        if (passed && score >= MIN_SCORE) {
            escrow.release(taskId, agent);
            agentRegistry.recordSuccess(agent, score);
            taskRegistry.markSettled(taskId);
        } else {
            escrow.refund(taskId);            // budget back to requester
            agentRegistry.slash(agent, requester); // penalty to requester
            taskRegistry.markFailed(taskId);
        }
    }
}
