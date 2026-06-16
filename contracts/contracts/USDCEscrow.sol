// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * USDCEscrow — holds the task budget between posting and settlement.
 *
 * FIX vs the original Polaris build prompt: the prompt had BOTH TaskRegistry and
 * this contract call `transferFrom(requester, ...)` for the same budget, so the
 * second pull always reverted (no allowance) and every task creation failed.
 * Here, this contract is the SOLE puller of funds — the requester approves the
 * escrow, TaskRegistry only calls lockFunds(), and lockFunds() does the single
 * transferFrom. Releases/refunds/slashes pay out only what the escrow actually
 * holds for that task, so the contract can never over-pay its balance.
 */
contract USDCEscrow is ReentrancyGuard {
    IERC20 public immutable usdc;
    address public owner;
    address public verifierBridge;
    address public taskRegistry;

    mapping(bytes32 => uint256) public taskEscrow;   // taskId => locked amount
    mapping(bytes32 => address) public taskRequester; // taskId => who funded it
    mapping(bytes32 => bool) public resolved;        // released or refunded

    event FundsLocked(bytes32 indexed taskId, address indexed requester, uint256 amount);
    event FundsReleased(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event FundsRefunded(bytes32 indexed taskId, address indexed requester, uint256 amount);

    modifier onlyAuthorized() {
        require(msg.sender == verifierBridge || msg.sender == taskRegistry, "Not authorized");
        _;
    }

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        owner = msg.sender;
    }

    function setVerifierBridge(address _b) external {
        require(msg.sender == owner, "Only owner");
        verifierBridge = _b;
    }

    function setTaskRegistry(address _r) external {
        require(msg.sender == owner, "Only owner");
        taskRegistry = _r;
    }

    /// Pull `amount` USDC from `requester` (who must have approved this contract).
    function lockFunds(bytes32 taskId, address requester, uint256 amount) external onlyAuthorized nonReentrant {
        require(taskEscrow[taskId] == 0, "Already locked");
        require(amount > 0, "Zero budget");
        require(usdc.transferFrom(requester, address(this), amount), "USDC transferFrom failed");
        taskEscrow[taskId] = amount;
        taskRequester[taskId] = requester;
        emit FundsLocked(taskId, requester, amount);
    }

    /// Release the locked budget to the agent on a passing verification.
    function release(bytes32 taskId, address agent) external onlyAuthorized nonReentrant {
        require(!resolved[taskId], "Already resolved");
        uint256 amount = taskEscrow[taskId];
        require(amount > 0, "Nothing escrowed");
        resolved[taskId] = true;
        taskEscrow[taskId] = 0;
        require(usdc.transfer(agent, amount), "USDC transfer failed");
        emit FundsReleased(taskId, agent, amount);
    }

    /// Refund the budget to the requester (failed verification or cancellation).
    function refund(bytes32 taskId) external onlyAuthorized nonReentrant {
        require(!resolved[taskId], "Already resolved");
        uint256 amount = taskEscrow[taskId];
        require(amount > 0, "Nothing escrowed");
        address requester = taskRequester[taskId];
        resolved[taskId] = true;
        taskEscrow[taskId] = 0;
        require(usdc.transfer(requester, amount), "USDC transfer failed");
        emit FundsRefunded(taskId, requester, amount);
    }
}
