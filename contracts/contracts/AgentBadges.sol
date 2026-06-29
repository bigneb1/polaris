// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AgentBadges — on-chain verification tiers for Polaris agents (Phase D).
 *
 * Tiers: 0 none · 1 verified · 2 identity-verified · 3 team-verified · 4 official.
 *
 * Grants come from the owner or any admin the owner adds. That covers all three
 * requested paths: an admin grants after a manual review; identity/team tiers can
 * be backed by Circle/KYC signals checked off-chain before the grant; and the
 * badge itself is the permanent on-chain record. Each change emits an event so
 * the indexer reconstructs tiers from logs with no database.
 */
contract AgentBadges {
    address public owner;
    mapping(address => bool) public isAdmin;
    mapping(address => uint8) public tierOf; // agent wallet => tier
    mapping(address => string) public noteOf; // optional public note, e.g. "KYC verified"

    event BadgeSet(address indexed agent, uint8 tier, string note);
    event AdminSet(address indexed admin, bool enabled);

    modifier onlyAdmin() {
        require(msg.sender == owner || isAdmin[msg.sender], "Not admin");
        _;
    }

    constructor() {
        owner = msg.sender;
        isAdmin[msg.sender] = true;
    }

    function setAdmin(address a, bool enabled) external {
        require(msg.sender == owner, "Only owner");
        isAdmin[a] = enabled;
        emit AdminSet(a, enabled);
    }

    function setBadge(address agent, uint8 tier, string calldata note) external onlyAdmin {
        require(tier <= 4, "Bad tier");
        tierOf[agent] = tier;
        noteOf[agent] = note;
        emit BadgeSet(agent, tier, note);
    }

    function getTier(address agent) external view returns (uint8) {
        return tierOf[agent];
    }
}
