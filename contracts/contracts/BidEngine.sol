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
 * Score = price 40% + reputation 40% + speed 20%, computed ON-CHAIN at bid time
 * (fixing SynapseMesh, where the winner was trusted from an off-chain script).
 * awardBid() recomputes nothing it can't see: it simply selects the highest
 * stored bidScore and assigns via TaskRegistry, so the outcome is deterministic
 * and anyone — including an autonomous agent — can settle the auction.
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

    mapping(bytes32 => Bid[]) public bids;
    mapping(bytes32 => bool) public auctionClosed;

    event BidPlaced(bytes32 indexed taskId, address indexed agent, uint256 amount, uint256 score, uint256 etaSeconds);
    event BidAwarded(bytes32 indexed taskId, address indexed winner, uint256 amount);

    constructor(address _agentRegistry) {
        agentRegistry = IAgentRegistry(_agentRegistry);
        owner = msg.sender;
    }

    function setTaskRegistry(address _t) external {
        require(msg.sender == owner, "Only owner");
        taskRegistry = ITaskRegistry(_t);
    }

    function placeBid(bytes32 taskId, uint256 bidAmount, uint256 etaSeconds) external {
        require(!auctionClosed[taskId], "Auction closed");
        require(agentRegistry.isOnline(msg.sender), "Agent offline");
        require(bidAmount > 0, "Zero bid");

        uint256 rep = agentRegistry.getReputation(msg.sender);
        require(rep >= MIN_REP_TO_BID, "Reputation below 70");

        // price: cheaper is better, capped at 100 (1 USDC bid == 100)
        uint256 priceScore = (1_000_000 * 100) / bidAmount;
        if (priceScore > 100) priceScore = 100;

        // reputation: 0..1000 scaled to 0..100
        uint256 repScore = rep / 10;

        // speed: <=1h is full marks, decays after
        uint256 speedScore = etaSeconds <= 3600 ? 100 : (3600 * 100) / etaSeconds;

        uint256 score = (priceScore * 40 + repScore * 40 + speedScore * 20) / 100;

        bids[taskId].push(Bid(msg.sender, bidAmount, score, etaSeconds, block.timestamp));
        emit BidPlaced(taskId, msg.sender, bidAmount, score, etaSeconds);
    }

    function awardBid(bytes32 taskId) external {
        require(!auctionClosed[taskId], "Auction closed");
        Bid[] storage taskBids = bids[taskId];
        require(taskBids.length > 0, "No bids");

        uint256 bestScore;
        address winner;
        uint256 winAmount;
        for (uint256 i = 0; i < taskBids.length; i++) {
            if (taskBids[i].bidScore > bestScore) {
                bestScore = taskBids[i].bidScore;
                winner = taskBids[i].agent;
                winAmount = taskBids[i].bidAmount;
            }
        }

        auctionClosed[taskId] = true;
        taskRegistry.assignAgent(taskId, winner, winAmount);
        emit BidAwarded(taskId, winner, winAmount);
    }

    function bidCount(bytes32 taskId) external view returns (uint256) {
        return bids[taskId].length;
    }
}
