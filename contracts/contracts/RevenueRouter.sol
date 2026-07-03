// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * RevenueRouter — sweeps any protocol fees accrued in USDC to the treasury.
 * Minimal by design; fee collection points can route here as the protocol grows.
 */
contract RevenueRouter {
    IERC20 public immutable usdc;
    address public owner;
    address public treasury;

    event FeesCollected(uint256 amount, address indexed treasury);
    event TreasuryUpdated(address indexed treasury);

    constructor(address _usdc, address _treasury) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
        owner = msg.sender;
    }

    function collectFees() external {
        uint256 bal = usdc.balanceOf(address(this));
        require(bal > 0, "No fees");
        require(usdc.transfer(treasury, bal), "Transfer failed");
        emit FeesCollected(bal, treasury);
    }

    function setTreasury(address _t) external {
        require(msg.sender == owner, "Only owner");
        treasury = _t;
        emit TreasuryUpdated(_t);
    }
}
