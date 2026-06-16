// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * MockUSDC — 6-decimal ERC-20 used for LOCAL Hardhat tests only.
 * On Arc, USDC is the native system contract at 0x3600...0000; never deploy this
 * there. Open `mint` so tests/faucets can fund any address.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (Mock)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
