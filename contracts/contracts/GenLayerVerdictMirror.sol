// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * Chain-neutral receipt registry for finalized GenLayer verdicts.
 *
 * This contract does not pretend to verify GenLayer consensus. A narrow relay
 * attests what it observed after finality; the complete source/evidence binding
 * makes an incorrect relay publicly detectable. It can be replaced by native
 * GenLayer proof/message verification without changing Polaris case ids.
 */
contract GenLayerVerdictMirror is ReentrancyGuard {
    using MessageHashUtils for bytes32;

    struct Verdict {
        uint256 sourceChainId;
        address sourceContract;
        bytes32 sourceId;
        bytes32 evidenceHash;
        uint8 kind; // 1 task, 2 dispute
        bool outcome; // passed or upheld
        uint8 score; // task score or dispute confidence
        bytes32 reasoningHash;
        uint64 timestamp;
    }

    address public owner;
    address public trustedSigner;
    mapping(bytes32 => Verdict) public verdicts;

    event VerdictRecorded(
        bytes32 indexed decisionId,
        uint8 indexed kind,
        bytes32 indexed sourceId,
        uint256 sourceChainId,
        address sourceContract,
        bytes32 evidenceHash,
        bool outcome,
        uint8 score,
        bytes32 reasoningHash
    );
    event TrustedSignerUpdated(address indexed signer);

    constructor(address signer) {
        require(signer != address(0), "Zero signer");
        owner = msg.sender;
        trustedSigner = signer;
    }

    function setTrustedSigner(address signer) external {
        require(msg.sender == owner, "Only owner");
        require(signer != address(0), "Zero signer");
        trustedSigner = signer;
        emit TrustedSignerUpdated(signer);
    }

    function recordVerdict(
        bytes32 decisionId,
        uint256 sourceChainId,
        address sourceContract,
        bytes32 sourceId,
        bytes32 evidenceHash,
        uint8 kind,
        bool outcome,
        uint8 score,
        bytes32 reasoningHash,
        bytes calldata signature
    ) external nonReentrant {
        require(msg.sender == trustedSigner, "Only relay");
        require(decisionId != bytes32(0), "Zero decision");
        require(sourceContract != address(0), "Zero source");
        require(kind == 1 || kind == 2, "Bad kind");
        require(score <= 100, "Bad score");
        require(verdicts[decisionId].timestamp == 0, "Already recorded");

        bytes32 digest = keccak256(abi.encodePacked(
            block.chainid,
            address(this),
            decisionId,
            sourceChainId,
            sourceContract,
            sourceId,
            evidenceHash,
            kind,
            outcome,
            score,
            reasoningHash
        )).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        verdicts[decisionId] = Verdict({
            sourceChainId: sourceChainId,
            sourceContract: sourceContract,
            sourceId: sourceId,
            evidenceHash: evidenceHash,
            kind: kind,
            outcome: outcome,
            score: score,
            reasoningHash: reasoningHash,
            timestamp: uint64(block.timestamp)
        });
        emit VerdictRecorded(decisionId, kind, sourceId, sourceChainId, sourceContract, evidenceHash, outcome, score, reasoningHash);
    }
}
