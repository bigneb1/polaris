// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAgentRegistry {
    function getReputation(address w) external view returns (uint256);
    function isOnline(address w) external view returns (bool);
}

uint256 constant MIN_REP_TO_BID = 70;

interface ITaskRegistry {
    function assignAgent(bytes32 taskId, address agent, uint256 bidAmount) external;
}

/**
 * BidEngine — on-chain reverse auction.
 *
 * Score = price·25 + reputation·10 + speed·10 + RANDOM·55, computed ON-CHAIN at
 * bid time (fixing SynapseMesh, where the winner was trusted from an off-chain
 * script). The RANDOM term dominates so this is effectively a raffle among the
 * bidders — reputation is a light tie-breaker, not the decider, so lower-rep and
 * slower agents genuinely win their share while every agent still bids (a real,
 * visible auction). awardBid() recomputes
 * nothing it can't see: it selects the highest stored bidScore and assigns via
 * TaskRegistry, so the outcome stays deterministic AFTER bids are in and anyone
 * — including an autonomous agent — can settle the auction.
 *
 * The randomness is mixed from block entropy + the bidder + the bid index. It is
 * NOT cryptographically secure (a determined bidder could grind the block it
 * bids in); that is an acceptable trade for a testnet fairness raffle, since the
 * worst case is merely *which* honest agent wins — no funds are at risk.
 */
contract BidEngine {
    IAgentRegistry public agentRegistry;
    ITaskRegistry public taskRegistry;
    address public owner;

    struct Bid {
        address agent;
        uint256 bidAmount;
        uint256 bidScore;
        uint256 etaSeconds;
        uint256 timestamp;
    }

    // Cap total bids per task so awardBid's scan can never approach the block
    // gas limit, and reject a second bid from the same agent within the same
    // "generation" (bumped on reopenAuction) so a single agent can't grind the
    // random-dominated score by resubmitting — see docs/AUDIT_REPORT.md, Bug #2.
    uint256 public constant MAX_BIDS_PER_TASK = 50;
    /// One whole unit of the settlement asset, for price scoring. Set at deploy so
    /// the same engine works for a 6-decimal stablecoin and an 18-decimal coin.
    uint256 public immutable PRICE_UNIT;

    mapping(bytes32 => Bid[]) public bids;
    mapping(bytes32 => bool) public auctionClosed;
    mapping(bytes32 => uint256) public bidGeneration;
    mapping(bytes32 => mapping(uint256 => mapping(address => bool))) public hasBid;

    event BidPlaced(bytes32 indexed taskId, address indexed agent, uint256 amount, uint256 score, uint256 etaSeconds);
    event BidAwarded(bytes32 indexed taskId, address indexed winner, uint256 amount);

    /// @param _priceUnit one whole unit of the settlement asset, the reference for
    ///        price scoring: 1e6 for a 6-decimal stablecoin, 1e18 for an 18-decimal
    ///        native coin. This used to be a hardcoded `1_000_000`, which silently
    ///        meant "USDC". On an 18-decimal chain that made priceScore 0 for every
    ///        realistic bid, so the 25% price weight vanished and the auction stopped
    ///        rewarding cheaper bids at all.
    constructor(address _agentRegistry, uint256 _priceUnit) {
        require(_priceUnit > 0, "Zero price unit");
        agentRegistry = IAgentRegistry(_agentRegistry);
        PRICE_UNIT = _priceUnit;
        owner = msg.sender;
    }

    function setTaskRegistry(address _t) external {
        require(msg.sender == owner, "Only owner");
        require(_t != address(0), "Zero address");
        taskRegistry = ITaskRegistry(_t);
    }

    function placeBid(bytes32 taskId, uint256 bidAmount, uint256 etaSeconds) external {
        require(!auctionClosed[taskId], "Auction closed");
        require(agentRegistry.isOnline(msg.sender), "Agent offline");
        require(bidAmount > 0, "Zero bid");
        require(bids[taskId].length < MAX_BIDS_PER_TASK, "Too many bids");
        require(!hasBid[taskId][bidGeneration[taskId]][msg.sender], "Already bid");

        uint256 rep = agentRegistry.getReputation(msg.sender);
        require(rep >= MIN_REP_TO_BID, "Reputation below 70");

        // price: cheaper is better, capped at 100 (a one-unit bid scores 100)
        uint256 priceScore = (PRICE_UNIT * 100) / bidAmount;
        if (priceScore > 100) priceScore = 100;

        // reputation: 0..1000 scaled to 0..100
        uint256 repScore = rep / 10;

        // speed: <=1h is full marks, decays after
        uint256 speedScore = etaSeconds <= 3600 ? 100 : (3600 * 100) / etaSeconds;

        // fairness lottery: a per-bid pseudo-random 0..100 term so every agent
        // has a real shot, not just the highest-reputation one. Mixed from block
        // entropy + the bidder + this task's current bid count so two agents
        // bidding in the same block still get different rolls.
        uint256 randScore = uint256(
            keccak256(
                abi.encodePacked(
                    blockhash(block.number - 1),
                    block.prevrandao,
                    block.timestamp,
                    taskId,
                    msg.sender,
                    bids[taskId].length
                )
            )
        ) % 101;

        // Raffle-dominant scoring so lower-reputation / slower agents genuinely
        // win their share (reputation is now a light tie-breaker, not the decider):
        // price·25 + reputation·10 + speed·10 + RANDOM·55.
        uint256 score = (priceScore * 25 + repScore * 10 + speedScore * 10 + randScore * 55) / 100;

        hasBid[taskId][bidGeneration[taskId]][msg.sender] = true;
        bids[taskId].push(Bid(msg.sender, bidAmount, score, etaSeconds, block.timestamp));
        emit BidPlaced(taskId, msg.sender, bidAmount, score, etaSeconds);
    }

    function awardBid(bytes32 taskId) external {
        require(!auctionClosed[taskId], "Auction closed");
        Bid[] storage taskBids = bids[taskId];
        require(taskBids.length > 0, "No bids");

        // Skip bids from an agent that went offline/deregistered since bidding
        // (e.g. bid then deactivate+withdrawStake while idle) — otherwise a
        // stale winning bid from a now-unregistered agent would permanently
        // revert every future award attempt for this task. See
        // docs/AUDIT_REPORT.md, Bug #4.
        uint256 bestScore;
        address winner;
        uint256 winAmount;
        for (uint256 i = 0; i < taskBids.length; i++) {
            if (taskBids[i].bidScore > bestScore && agentRegistry.isOnline(taskBids[i].agent)) {
                bestScore = taskBids[i].bidScore;
                winner = taskBids[i].agent;
                winAmount = taskBids[i].bidAmount;
            }
        }
        require(winner != address(0), "No eligible bids");

        auctionClosed[taskId] = true;
        taskRegistry.assignAgent(taskId, winner, winAmount);
        emit BidAwarded(taskId, winner, winAmount);
    }

    function bidCount(bytes32 taskId) external view returns (uint256) {
        return bids[taskId].length;
    }

    /// Reset the auction so a reopened task can take fresh bids. Only the
    /// TaskRegistry (which owns task lifecycle) may call this.
    function reopenAuction(bytes32 taskId) external {
        require(msg.sender == address(taskRegistry), "Only taskRegistry");
        auctionClosed[taskId] = false;
        delete bids[taskId];
        bidGeneration[taskId] += 1; // lets every agent, including prior bidders, bid fresh
    }
}
