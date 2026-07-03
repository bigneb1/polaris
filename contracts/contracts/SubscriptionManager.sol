// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
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
 * Self-custodial: this contract holds its own USDC and is not wired into the
 * existing V4 contracts, so it deploys/upgrades without touching live settlement.
 */
contract SubscriptionManager is ReentrancyGuard {
    using MessageHashUtils for bytes32;

    IERC20 public immutable usdc;
    address public owner;
    address public trustedSigner;
    uint8 public constant MIN_SCORE = 70;

    struct Subscription {
        address subscriber;
        address agent;
        uint256 perDeliveryUsdc;
        uint32 totalDeliveries;
        uint32 deliveriesDone;
        uint256 escrowed; // USDC still held for future deliveries + refund
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

    constructor(address _usdc, address _signer) {
        usdc = IERC20(_usdc);
        trustedSigner = _signer;
        owner = msg.sender;
    }

    function setTrustedSigner(address _signer) external {
        require(msg.sender == owner, "Only owner");
        trustedSigner = _signer;
        emit TrustedSignerUpdated(_signer);
    }

    /// Create + fully fund a subscription. Subscriber must approve this contract
    /// for perDeliveryUsdc × totalDeliveries first.
    function createSubscription(
        bytes32 subId,
        address agent,
        uint256 perDeliveryUsdc,
        uint32 totalDeliveries,
        PlanMeta calldata meta
    ) external nonReentrant {
        require(subscriptions[subId].subscriber == address(0), "Exists");
        require(agent != address(0), "No agent");
        require(perDeliveryUsdc > 0 && totalDeliveries > 0, "Bad plan");

        uint256 total = perDeliveryUsdc * totalDeliveries;
        require(usdc.transferFrom(msg.sender, address(this), total), "USDC transferFrom failed");

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

        bytes32 digest = keccak256(abi.encodePacked(subId, index, deliverableHash, score)).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        deliveryReleased[subId][index] = true;
        s.deliveriesDone += 1;
        s.escrowed -= s.perDeliveryUsdc;
        if (s.deliveriesDone == s.totalDeliveries) s.active = false; // plan complete

        require(usdc.transfer(s.agent, s.perDeliveryUsdc), "Agent transfer failed");
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
        if (refund > 0) require(usdc.transfer(s.subscriber, refund), "Refund failed");
        emit SubscriptionCancelled(subId, refund);
    }

    function getSubscription(bytes32 subId) external view returns (Subscription memory) {
        return subscriptions[subId];
    }
}
