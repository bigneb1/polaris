// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * NativeSubscriptionManager — the native-coin twin of SubscriptionManager, for
 * chains that settle in their own coin (BOT Chain) rather than in an ERC-20.
 *
 * Same rules, events and signatures as SubscriptionManager so the scheduler, the
 * indexer and the frontend ABIs are unchanged. The native differences:
 * `createSubscription` is payable and requires the whole plan budget as
 * `msg.value` (no approve step), payouts go out through `_send` with `call{value:}`
 * so ERC-4337 smart-account recipients work, and `receive()` reverts so the
 * contract balance always equals the sum of escrowed plans.
 *
 * Original description follows.
 *
 * SubscriptionManager — recurring tasks on Polaris.
 *
 * A subscriber pre-funds a fixed number of scheduled deliveries from one agent
 * (e.g. "5 Twitter threads / week", "daily market report"). The full plan budget
 * (perDelivery × totalDeliveries) is escrowed up front, and each scheduled drop
 * releases exactly one perDelivery slice to the agent once the off-chain verifier
 * signs the delivery verdict — the SAME trusted-signer ECDSA model as
 * VerifierBridge (scoring is off-chain; the signature binds the deliverable hash
 * + score, so each release carries a permanent on-chain attestation).
 *
 * HYBRID MODEL: funds + per-delivery release + cancel/refund are on-chain here;
 * the cadence/day/time scheduling that decides WHEN a delivery is due lives
 * off-chain in the agent runtime (it produces the work then calls recordDelivery
 * with a signed verdict). All plan metadata is emitted in events so the index can
 * reconstruct subscriptions with no database.
 *
 * Self-custodial: this contract holds its own balance and is not wired into the
 * core market contracts, so it deploys/upgrades without touching live settlement.
 */
contract NativeSubscriptionManager is ReentrancyGuard {
    using MessageHashUtils for bytes32;

    address public owner;
    address public trustedSigner;
    uint8 public constant MIN_SCORE = 70;

    struct Subscription {
        address subscriber;
        address agent;
        uint256 perDeliveryUsdc;
        uint32 totalDeliveries;
        uint32 deliveriesDone;
        uint256 escrowed; // native coin still held for future deliveries + refund
        bool active;
    }

    // Plan metadata, grouped into one calldata struct so the create call stays
    // under the stack limit (and emitted in full for index reconstruction).
    struct PlanMeta {
        string title;
        string brief;
        string rubric;
        string taskType;
        string schedule; // off-chain cadence string, e.g. "mon,wed,fri@09:00"
    }

    mapping(bytes32 => Subscription) public subscriptions;
    // subId => delivery index => released, so a verdict can't be replayed.
    mapping(bytes32 => mapping(uint32 => bool)) public deliveryReleased;

    event SubscriptionCreated(
        bytes32 indexed subId,
        address indexed subscriber,
        address indexed agent,
        uint256 perDeliveryUsdc,
        uint32 totalDeliveries,
        string title,
        string brief,
        string rubric,
        string taskType,
        string schedule
    );
    event DeliveryReleased(
        bytes32 indexed subId,
        address indexed agent,
        uint32 index,
        uint256 amount,
        uint8 score,
        bytes32 deliverableHash
    );
    event SubscriptionCancelled(bytes32 indexed subId, uint256 refund);
    event TrustedSignerUpdated(address indexed signer);

    constructor(address _signer) {
        require(_signer != address(0), "Zero address");
        trustedSigner = _signer;
        owner = msg.sender;
    }

    function setTrustedSigner(address _signer) external {
        require(msg.sender == owner, "Only owner");
        require(_signer != address(0), "Zero address");
        trustedSigner = _signer;
        emit TrustedSignerUpdated(_signer);
    }

    /// Create + fully fund a subscription. The whole plan budget
    /// (perDeliveryUsdc × totalDeliveries) travels with the call as msg.value, so
    /// there is no approval step and no approve-mined-but-create-failed state.
    function createSubscription(
        bytes32 subId,
        address agent,
        uint256 perDeliveryUsdc,
        uint32 totalDeliveries,
        PlanMeta calldata meta
    ) external payable nonReentrant {
        require(subscriptions[subId].subscriber == address(0), "Exists");
        require(agent != address(0), "No agent");
        require(perDeliveryUsdc > 0 && totalDeliveries > 0, "Bad plan");

        uint256 total = perDeliveryUsdc * totalDeliveries;
        require(msg.value == total, "Value must equal plan total");

        subscriptions[subId] = Subscription({
            subscriber: msg.sender,
            agent: agent,
            perDeliveryUsdc: perDeliveryUsdc,
            totalDeliveries: totalDeliveries,
            deliveriesDone: 0,
            escrowed: total,
            active: true
        });

        emit SubscriptionCreated(
            subId, msg.sender, agent, perDeliveryUsdc, totalDeliveries,
            meta.title, meta.brief, meta.rubric, meta.taskType, meta.schedule
        );
    }

    /// Release one delivery slice to the agent on a verifier-signed passing verdict.
    /// The signature binds (subId, index, deliverableHash, score) so it can be
    /// produced off-chain by the trusted signer and replayed by anyone exactly once.
    function recordDelivery(
        bytes32 subId,
        uint32 index,
        bytes32 deliverableHash,
        uint8 score,
        bytes calldata signature
    ) external nonReentrant {
        Subscription storage s = subscriptions[subId];
        require(s.active, "Inactive");
        require(index < s.totalDeliveries, "Bad index");
        require(!deliveryReleased[subId][index], "Released");
        require(score >= MIN_SCORE, "Below MIN_SCORE");

        bytes32 digest = keccak256(
            abi.encodePacked(block.chainid, address(this), subId, index, deliverableHash, score)
        ).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        deliveryReleased[subId][index] = true;
        s.deliveriesDone += 1;
        s.escrowed -= s.perDeliveryUsdc;
        if (s.deliveriesDone == s.totalDeliveries) s.active = false; // plan complete

        _send(s.agent, s.perDeliveryUsdc);
        emit DeliveryReleased(subId, s.agent, index, s.perDeliveryUsdc, score, deliverableHash);
    }

    /// Cancel and refund the remaining (undelivered) escrow to the subscriber.
    function cancelSubscription(bytes32 subId) external nonReentrant {
        Subscription storage s = subscriptions[subId];
        require(s.subscriber == msg.sender, "Not subscriber");
        require(s.active, "Inactive");

        uint256 refund = s.escrowed;
        s.escrowed = 0;
        s.active = false;
        _send(s.subscriber, refund);
        emit SubscriptionCancelled(subId, refund);
    }

    function getSubscription(bytes32 subId) external view returns (Subscription memory) {
        return subscriptions[subId];
    }

    /// Native transfer that bubbles a failure instead of swallowing it. Not
    /// `transfer()`, whose 2300-gas stipend breaks contract-account recipients.
    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        require(to != address(0), "Zero recipient");
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Native transfer failed");
    }

    /// Plans are funded through createSubscription only; stray value would break
    /// the escrow accounting.
    receive() external payable {
        revert("Fund via createSubscription");
    }
}
