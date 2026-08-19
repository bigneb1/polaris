// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IAgentReg {
    function getReputation(address) external view returns (uint256);
    function isOnline(address) external view returns (bool);
}

/**
 * RecurringMarket — recurring tasks that go to the OPEN MARKET (Phase A++).
 *
 * Unlike a direct subscription (pick an agent), a recurring plan is auctioned:
 * the requester escrows the whole plan, agents BID, the best-scored bid wins (same
 * price·40 + reputation·40 + speed·20 formula as the task market), and then the
 * winning agent delivers on schedule — each scheduled drop releasing one slice of
 * USDC on a verifier-signed verdict. The competitive savings (funded perDelivery −
 * winning price) are refunded to the requester at award time. The off-chain
 * scheduler decides WHEN each drop is due (cadence lives in the plan metadata).
 */
contract RecurringMarket is ReentrancyGuard {
    using MessageHashUtils for bytes32;

    IERC20 public immutable usdc;
    IAgentReg public immutable agentRegistry;
    address public owner;
    address public trustedSigner;

    enum Status { NONE, OPEN, ACTIVE, COMPLETE, CANCELLED }

    struct Plan {
        address requester;
        address agent;
        uint256 perDelivery;   // funded ceiling per delivery
        uint256 price;         // winning bid actually paid per delivery
        uint32 total;
        uint32 done;
        uint256 escrowed;
        uint256 minReputation;
        Status status;
    }
    struct Bid {
        address agent;
        uint256 price;
        uint256 score;
    }

    struct PlanMeta { string title; string brief; string rubric; string taskType; string schedule; }

    // Bounds award()'s scan so it can never approach the block gas limit — see
    // docs/AUDIT_REPORT.md, Bug #5.
    uint256 public constant MAX_BIDS_PER_PLAN = 50;

    mapping(bytes32 => Plan) public plans;
    mapping(bytes32 => Bid[]) public bidsOf;
    mapping(bytes32 => mapping(uint32 => bool)) public delivered;

    event PlanCreated(bytes32 indexed planId, address indexed requester, uint256 perDelivery, uint32 total, uint256 minReputation, string title, string brief, string rubric, string taskType, string schedule);
    event PlanBid(bytes32 indexed planId, address indexed agent, uint256 price, uint256 score);
    event PlanAwarded(bytes32 indexed planId, address indexed agent, uint256 price);
    event DeliveryReleased(bytes32 indexed planId, address indexed agent, uint32 index, uint256 amount, uint8 score, bytes32 deliverableHash);
    event PlanCancelled(bytes32 indexed planId, uint256 refund);

    constructor(address _usdc, address _agentRegistry, address _signer) {
        usdc = IERC20(_usdc);
        agentRegistry = IAgentReg(_agentRegistry);
        trustedSigner = _signer;
        owner = msg.sender;
    }

    function setTrustedSigner(address s) external {
        require(msg.sender == owner, "Only owner");
        require(s != address(0), "Zero address");
        trustedSigner = s;
    }

    function createPlan(bytes32 planId, uint256 perDelivery, uint32 total, uint256 minReputation, PlanMeta calldata meta) external nonReentrant {
        require(plans[planId].status == Status.NONE, "Exists");
        require(perDelivery > 0 && total > 0, "Bad plan");
        uint256 funded = perDelivery * total;
        require(usdc.transferFrom(msg.sender, address(this), funded), "USDC transferFrom failed");
        plans[planId] = Plan(msg.sender, address(0), perDelivery, 0, total, 0, funded, minReputation, Status.OPEN);
        emit PlanCreated(planId, msg.sender, perDelivery, total, minReputation, meta.title, meta.brief, meta.rubric, meta.taskType, meta.schedule);
    }

    /// Agent bids a per-delivery price (≤ the funded ceiling). Scored on-chain.
    function bid(bytes32 planId, uint256 price, uint256 etaSeconds) external {
        Plan storage p = plans[planId];
        require(p.status == Status.OPEN, "Not open");
        require(price > 0 && price <= p.perDelivery, "Bad price");
        require(bidsOf[planId].length < MAX_BIDS_PER_PLAN, "Too many bids");
        require(agentRegistry.isOnline(msg.sender), "Agent offline");
        uint256 rep = agentRegistry.getReputation(msg.sender);
        require(rep >= p.minReputation, "Reputation too low");

        uint256 priceScore = (1_000_000 * 100) / price;
        if (priceScore > 100) priceScore = 100;
        uint256 repScore = rep / 10;
        if (repScore > 100) repScore = 100;
        uint256 speedScore = etaSeconds <= 3600 ? 100 : (3600 * 100) / etaSeconds;
        uint256 score = (priceScore * 40 + repScore * 40 + speedScore * 20) / 100;

        bidsOf[planId].push(Bid(msg.sender, price, score));
        emit PlanBid(planId, msg.sender, price, score);
    }

    /// Close the auction: assign the best-scored bid, refund the competitive savings.
    function award(bytes32 planId) external nonReentrant {
        Plan storage p = plans[planId];
        require(p.status == Status.OPEN, "Not open");
        Bid[] storage bids = bidsOf[planId];
        require(bids.length > 0, "No bids");

        uint256 best;
        for (uint256 i = 1; i < bids.length; i++) {
            if (bids[i].score > bids[best].score) best = i;
        }
        Bid storage w = bids[best];
        p.agent = w.agent;
        p.price = w.price;
        p.status = Status.ACTIVE;

        uint256 needed = w.price * p.total;
        uint256 refund = p.escrowed - needed; // funded ceiling minus what the bid needs
        p.escrowed = needed;
        if (refund > 0) require(usdc.transfer(p.requester, refund), "Refund failed");
        emit PlanAwarded(planId, w.agent, w.price);
    }

    /// Release one scheduled drop to the agent on a verifier-signed verdict.
    function recordDelivery(bytes32 planId, uint32 index, bytes32 deliverableHash, uint8 score, bytes calldata signature) external nonReentrant {
        Plan storage p = plans[planId];
        require(p.status == Status.ACTIVE, "Not active");
        require(index < p.total && !delivered[planId][index], "Bad/dup index");
        require(score >= 70, "Below MIN_SCORE");
        bytes32 digest = keccak256(
            abi.encodePacked(block.chainid, address(this), planId, index, deliverableHash, score)
        ).toEthSignedMessageHash();
        require(ECDSA.recover(digest, signature) == trustedSigner, "Bad signature");

        delivered[planId][index] = true;
        p.done += 1;
        p.escrowed -= p.price;
        if (p.done == p.total) p.status = Status.COMPLETE;
        require(usdc.transfer(p.agent, p.price), "Agent transfer failed");
        emit DeliveryReleased(planId, p.agent, index, p.price, score, deliverableHash);
    }

    /// Requester cancels (open or active) and reclaims the remaining escrow.
    function cancelPlan(bytes32 planId) external nonReentrant {
        Plan storage p = plans[planId];
        require(p.requester == msg.sender, "Not requester");
        require(p.status == Status.OPEN || p.status == Status.ACTIVE, "Not cancellable");
        uint256 refund = p.escrowed;
        p.escrowed = 0;
        p.status = Status.CANCELLED;
        if (refund > 0) require(usdc.transfer(p.requester, refund), "Refund failed");
        emit PlanCancelled(planId, refund);
    }

    function getPlan(bytes32 planId) external view returns (Plan memory) {
        return plans[planId];
    }
    function bidCount(bytes32 planId) external view returns (uint256) {
        return bidsOf[planId].length;
    }
}
