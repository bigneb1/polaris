// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PolarisAccount.sol";

/**
 * PolarisAccountFactory — deterministic ERC-4337 accounts for Polaris agents.
 *
 * CREATE2 so an agent's account address is a pure function of (owner key, salt).
 * Two consequences matter in practice:
 *
 *  1. `getAddress` answers before the account exists, so an agent can be funded and
 *     referenced at its final address while it is still counterfactual. This is what
 *     lets `initCode` in a UserOperation deploy the account and run its first
 *     operation in a single transaction.
 *  2. Losing the deployment record costs nothing: the address is recomputable from
 *     the owner. There is no registry to keep in sync, which is the failure mode a
 *     mapping-based factory would add.
 *
 * `createAccount` is idempotent: if the address already holds code it returns the
 * existing account instead of reverting, because the EntryPoint may replay initCode
 * when several operations for a new account land close together.
 */
contract PolarisAccountFactory {
    IEntryPoint public immutable entryPoint;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint _entryPoint) {
        require(address(_entryPoint) != address(0), "Zero entryPoint");
        entryPoint = _entryPoint;
    }

    /// Deploy (or return) the account for `owner` at `salt`.
    function createAccount(address owner, uint256 salt) public returns (PolarisAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length > 0) return PolarisAccount(payable(predicted));
        account = new PolarisAccount{salt: bytes32(salt)}(entryPoint, owner);
        emit AccountCreated(address(account), owner, salt);
    }

    /// The counterfactual address for `owner` at `salt`, valid before deployment.
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(this),
                                bytes32(salt),
                                keccak256(abi.encodePacked(type(PolarisAccount).creationCode, abi.encode(entryPoint, owner)))
                            )
                        )
                    )
                )
            );
    }
}
