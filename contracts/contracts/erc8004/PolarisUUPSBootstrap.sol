// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * PolarisUUPSBootstrap — the placeholder implementation a Polaris-deployed ERC-8004
 * proxy points at for exactly one transaction.
 *
 * WHY THIS EXISTS: the ERC-8004 reference registries expose
 * `initialize(...) reinitializer(2) onlyOwner`, so an owner must already be set
 * before they can be initialised. The standard's own deployment solves this with a
 * `MinimalUUPS` placeholder — but that placeholder **hardcodes the standard's owner
 * address**, which would leave a Polaris-deployed proxy permanently upgradeable only
 * by a key Polaris doesn't hold.
 *
 * This is the same pattern with the owner passed in instead of baked in. It is the
 * only piece of the ERC-8004 deployment Polaris authors; the registries themselves
 * are vendored byte-identical from upstream.
 *
 * Lifecycle, per proxy:
 *   1. ERC1967Proxy(bootstrap, initialize(owner, identityRegistry))  → owner set
 *   2. owner calls upgradeToAndCall(realRegistry, initialize(...))   → real logic live
 * After step 2 this contract is no longer referenced by that proxy.
 *
 * `_identityRegistry` occupies slot 0 to match the real implementations, which keep
 * that field outside their ERC-7201 namespaced storage — so the value written here
 * survives the upgrade.
 */
contract PolarisUUPSBootstrap is OwnableUpgradeable, UUPSUpgradeable {
    /// @dev Slot 0, matching the real registries' layout.
    address private _identityRegistry;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param owner_ the address allowed to upgrade this proxy — Polaris's deployer,
     *        not the ERC-8004 standard's owner.
     * @param identityRegistry_ the Identity Registry proxy, or the zero address when
     *        this proxy IS the identity registry.
     */
    function initialize(address owner_, address identityRegistry_) public initializer {
        require(owner_ != address(0), "bad owner");
        __Ownable_init(owner_);
        // NOTE: no __UUPSUpgradeable_init() — OpenZeppelin 5.x's UUPSUpgradeable holds
        // no state and no longer defines an initializer (upstream's placeholder still
        // calls it because it was written against OZ 4.x).
        _identityRegistry = identityRegistry_;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function getVersion() external pure returns (string memory) {
        return "polaris-bootstrap-1";
    }
}
