// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * NativeEscrow — holds a task budget denominated in the chain's NATIVE coin
 * between posting and settlement. The native-value twin of USDCEscrow.
 *
 * Used on BOT Chain, where the payment asset is BOT itself rather than a
 * stablecoin. Arc keeps USDCEscrow unchanged.
 *
 * Deliberately mirrors USDCEscrow's function signatures and events exactly, so
 * VerifierBridge, TaskRegistry's interface and the event indexer all work against
 * either escrow with no branching. The differences are only in how value moves:
 *   - `lockFunds` is payable and requires `msg.value == amount` (there is no
 *     allowance to pull from, so the value must arrive with the call),
 *   - payouts use `call{value:}` instead of `transfer`.
 *
 * SAFETY: `call{value:}` hands control to the recipient, so every payout follows
 * checks-effects-interactions — `resolved` is set and the balance zeroed BEFORE
 * any transfer — and the whole contract is `nonReentrant`. Payouts also cannot
 * exceed what this contract actually holds for that task, so it can never over-pay
 * its balance.
 */
contract NativeEscrow is ReentrancyGuard {
    address public owner;
    address public verifierBridge;
    address public taskRegistry;

    mapping(bytes32 => uint256) public taskEscrow; // taskId => locked amount (wei)
    mapping(bytes32 => address) public taskRequester; // taskId => who funded it
    mapping(bytes32 => bool) public resolved; // released or refunded

    event FundsLocked(bytes32 indexed taskId, address indexed requester, uint256 amount);
    event FundsReleased(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event FundsRefunded(bytes32 indexed taskId, address indexed requester, uint256 amount);

    modifier onlyAuthorized() {
        require(msg.sender == verifierBridge || msg.sender == taskRegistry, "Not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setVerifierBridge(address _b) external {
        require(msg.sender == owner, "Only owner");
        require(_b != address(0), "Zero address");
        verifierBridge = _b;
    }

    function setTaskRegistry(address _r) external {
        require(msg.sender == owner, "Only owner");
        require(_r != address(0), "Zero address");
        taskRegistry = _r;
    }

    /// Lock the budget that arrived with this call. `requester` is credited as the
    /// refund recipient — it is the original caller of TaskRegistry, not the
    /// TaskRegistry contract that forwarded the value.
    function lockFunds(bytes32 taskId, address requester, uint256 amount) external payable onlyAuthorized nonReentrant {
        require(taskEscrow[taskId] == 0, "Already locked");
        require(amount > 0, "Zero budget");
        require(msg.value == amount, "Value must equal amount");
        require(requester != address(0), "Zero requester");
        taskEscrow[taskId] = amount;
        taskRequester[taskId] = requester;
        emit FundsLocked(taskId, requester, amount);
    }

    /// Release the whole locked budget to the agent on a passing verification.
    function release(bytes32 taskId, address agent) external onlyAuthorized nonReentrant {
        require(!resolved[taskId], "Already resolved");
        uint256 amount = taskEscrow[taskId];
        require(amount > 0, "Nothing escrowed");
        resolved[taskId] = true;
        taskEscrow[taskId] = 0;
        _send(agent, amount);
        emit FundsReleased(taskId, agent, amount);
    }

    /// Pay the agent `agentAmount` (the winning bid) and refund the remainder of
    /// the locked budget to the requester. On a passing verification the requester
    /// gets back (budget − winning bid) instead of paying the full budget.
    function releaseSplit(bytes32 taskId, address agent, uint256 agentAmount) external onlyAuthorized nonReentrant {
        require(!resolved[taskId], "Already resolved");
        uint256 amount = taskEscrow[taskId];
        require(amount > 0, "Nothing escrowed");
        resolved[taskId] = true;
        taskEscrow[taskId] = 0;
        uint256 pay = (agentAmount == 0 || agentAmount > amount) ? amount : agentAmount;
        _send(agent, pay);
        emit FundsReleased(taskId, agent, pay);
        if (amount > pay) {
            address requester = taskRequester[taskId];
            _send(requester, amount - pay);
            emit FundsRefunded(taskId, requester, amount - pay);
        }
    }

    /// Refund the budget to the requester (failed verification or cancellation).
    function refund(bytes32 taskId) external onlyAuthorized nonReentrant {
        require(!resolved[taskId], "Already resolved");
        uint256 amount = taskEscrow[taskId];
        require(amount > 0, "Nothing escrowed");
        address requester = taskRequester[taskId];
        resolved[taskId] = true;
        taskEscrow[taskId] = 0;
        _send(requester, amount);
        emit FundsRefunded(taskId, requester, amount);
    }

    /// Native transfer that bubbles a failure instead of silently swallowing it.
    /// Not `transfer()`: its 2300-gas stipend breaks smart-contract recipients,
    /// and an agent wallet here may well be a contract account.
    function _send(address to, uint256 amount) private {
        require(to != address(0), "Zero recipient");
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Native transfer failed");
    }

    /// Reject stray value: every coin in here must belong to a task, or the
    /// accounting above stops matching the balance.
    receive() external payable {
        revert("Send funds via TaskRegistry");
    }
}
