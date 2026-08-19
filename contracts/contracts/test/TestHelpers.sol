// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Test-only helpers. Never deployed to a real network.
 */

/**
 * Stand-in for TaskRegistry's `tasks()` view, so a dispute test can set up a
 * settled task without deploying and driving the whole market.
 */
contract MockTaskRegistryView {
    struct T {
        address requester;
        address assignedAgent;
        uint8 status;
    }

    mapping(bytes32 => T) private _tasks;

    function setTask(bytes32 taskId, address requester, address assignedAgent, uint8 status) external {
        _tasks[taskId] = T(requester, assignedAgent, status);
    }

    function tasks(bytes32 taskId) external view returns (
        bytes32 id, address requester, uint256 budgetUsdc, uint256 deadline,
        uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt, uint256 winningBid
    ) {
        T memory t = _tasks[taskId];
        return (taskId, t.requester, 0, 0, 0, t.assignedAgent, t.status, 0, 0);
    }
}

/**
 * A recipient that spends more than the 2300-gas stipend `transfer()` forwards, by
 * writing storage in `receive()`. Payouts must reach it — an ERC-4337 smart account
 * is a contract too, so using `transfer` instead of `call{value:}` would strand
 * every agent that holds one.
 */
contract GasHungryReceiver {
    uint256 public received;
    uint256 private filler;

    receive() external payable {
        received += msg.value;
        filler = block.timestamp; // second SSTORE, well past a 2300-gas budget
    }
}

/** Always reverts, for proving batch atomicity. */
contract AlwaysReverts {
    function boom() external pure {
        revert("boom");
    }
}

/**
 * Minimal ERC-721 that mints with `_safeMint`, matching how the ERC-8004 identity
 * registry issues an agent id. Used to prove an account can hold one.
 */
contract TestSafeMintNFT {
    mapping(uint256 => address) private _owners;

    function safeMintTo(address to, uint256 tokenId) external {
        _owners[tokenId] = to;
        if (to.code.length > 0) {
            bytes4 retval = IERC721ReceiverLike(to).onERC721Received(msg.sender, address(0), tokenId, "");
            require(retval == IERC721ReceiverLike.onERC721Received.selector, "ERC721InvalidReceiver");
        }
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owners[tokenId];
    }
}

interface IERC721ReceiverLike {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}
