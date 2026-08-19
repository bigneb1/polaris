// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * ERC-4337 v0.7 types and the slice of EntryPoint this account needs.
 *
 * Declared here rather than pulled from `@account-abstraction`: the only thing
 * required for interop is that the struct layout and function selectors match the
 * canonical EntryPoint, which is already deployed (byte-identical to Ethereum's) at
 * 0x0000000071727De22E5E9d8BAf0edAc6f37da032 on both BOT Chain networks. Adding a
 * dependency to restate three declarations would buy nothing and pin us to its
 * Solidity range.
 */
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    /// verificationGasLimit (high 128 bits) | callGasLimit (low 128 bits)
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    /// maxPriorityFeePerGas (high 128 bits) | maxFeePerGas (low 128 bits)
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPoint {
    function depositTo(address account) external payable;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * PolarisAccount — a minimal ERC-4337 v0.7 smart account for a Polaris agent.
 *
 * WHY IT EXISTS. BOT Chain has the canonical EntryPoint v0.7 deployed but no public
 * bundler and no 4337 paymaster, so nothing was using it. This is the account half
 * of making that real: an agent's identity becomes a contract that the EntryPoint
 * drives, rather than a raw key sending transactions directly. That gives the agent
 * a stable address independent of its signing key, the ability to batch a whole
 * bid-and-submit sequence into one operation, and a path to sponsored gas later
 * without changing the agent's address.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No session keys, no guardians, no upgrade
 * proxy, no paymaster logic. Every one of those adds a way to lose an agent's funds,
 * and none is needed for an agent that signs with one key. `owner` is immutable
 * precisely so a compromised relayer cannot rotate it.
 *
 * SECURITY MODEL
 *  - `validateUserOp` accepts calls only from the EntryPoint, and returns 1
 *    (SIG_VALIDATION_FAILED) rather than reverting on a bad signature, which is what
 *    the spec requires so the bundler can charge for the attempt.
 *  - `execute` / `executeBatch` accept the EntryPoint (the userOp path) or the owner
 *    directly (so an agent can always act without a working bundler, which matters
 *    on a chain with no third-party bundler to fall back on).
 *  - The signature is a plain EIP-191 personal-sign over the userOpHash, the same
 *    scheme the reference SimpleAccount uses, so any standard tool can drive it.
 */
contract PolarisAccount {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// Returned by validateUserOp when the signature does not check out. The spec
    /// reserves 1 for exactly this, and requires a return rather than a revert.
    uint256 private constant SIG_VALIDATION_FAILED = 1;
    /// ERC-1271's "signature is valid" return value.
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    IEntryPoint public immutable entryPoint;
    address public immutable owner;

    event PolarisAccountInitialised(address indexed owner, address indexed entryPoint);
    event Executed(address indexed target, uint256 value, bytes data);

    error NotFromEntryPoint();
    error NotOwnerOrEntryPoint();
    error CallFailed(bytes result);

    constructor(IEntryPoint _entryPoint, address _owner) {
        require(_owner != address(0), "Zero owner");
        require(address(_entryPoint) != address(0), "Zero entryPoint");
        entryPoint = _entryPoint;
        owner = _owner;
        emit PolarisAccountInitialised(_owner, address(_entryPoint));
    }

    /// Accept plain transfers: an agent is paid its bid in the chain's native coin.
    receive() external payable {}

    /**
     * ERC-4337 validation hook. The EntryPoint calls this before executing the
     * operation; returning 0 accepts it, 1 rejects the signature.
     *
     * `missingAccountFunds` is what this account still owes the EntryPoint as
     * prefund for the operation, so it is deposited here. Without that the
     * EntryPoint reverts the whole bundle with AA21, and on a chain with no
     * paymaster the account itself is the only thing that can pay.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert NotFromEntryPoint();

        address recovered = ECDSA.recover(userOpHash.toEthSignedMessageHash(), userOp.signature);
        validationData = recovered == owner ? 0 : SIG_VALIDATION_FAILED;

        if (missingAccountFunds > 0) {
            // Ignore failure on purpose: the EntryPoint checks the resulting deposit
            // itself and will reject the operation if it is still short. Reverting
            // here would turn a fixable underfunding into a failed bundle.
            (bool ok, ) = address(entryPoint).call{value: missingAccountFunds}(
                abi.encodeCall(IEntryPoint.depositTo, (address(this)))
            );
            ok;
        }
    }

    /// Execute one call. Used by the EntryPoint for a UserOperation, and available
    /// to the owner directly so an agent is never blocked by bundler trouble.
    function execute(address target, uint256 value, bytes calldata data) external {
        _requireOwnerOrEntryPoint();
        _call(target, value, data);
    }

    /**
     * Execute several calls in order, atomically.
     *
     * This is the point of an account for an agent: register-then-bid, or
     * submit-then-settle, become one operation that either fully happens or does
     * not, instead of a sequence that can strand the agent halfway.
     */
    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas) external {
        _requireOwnerOrEntryPoint();
        require(targets.length == datas.length && targets.length == values.length, "Length mismatch");
        for (uint256 i; i < targets.length; i++) {
            _call(targets[i], values[i], datas[i]);
        }
    }

    /**
     * ERC-1271 signature validation, so anything that checks "did this account sign
     * that message?" works: Polaris's own deliverable authentication does exactly
     * that (server/auth.js falls back to ERC-1271 for contract wallets), and so do
     * wallets and other dApps. Without it an agent acting through this account could
     * not prove authorship of its own work, because a contract cannot ECDSA-sign.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        // Accept both the raw hash and its EIP-191 personal_sign wrapping: callers
        // differ on which they present, and the owner signs the wrapped form.
        if (ECDSA.recover(hash, signature) == owner) return ERC1271_MAGIC_VALUE;
        if (ECDSA.recover(hash.toEthSignedMessageHash(), signature) == owner) return ERC1271_MAGIC_VALUE;
        return 0xffffffff;
    }

    /**
     * ERC-721 receiver hook.
     *
     * Required, not optional, for an agent account here: an ERC-8004 identity IS an
     * ERC-721, and the registry mints it with `_safeMint`, which reverts with
     * `ERC721InvalidReceiver` if the recipient contract does not implement this. The
     * first attempt to mint an identity for a smart-account agent failed exactly that
     * way, so without this an account can never hold its own identity.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// Top up this account's EntryPoint deposit, which pays for its operations.
    function addDeposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// This account's prefund balance held by the EntryPoint.
    function depositBalance() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /// The EntryPoint's nonce for this account, for building the next UserOperation.
    function getNonce() external view returns (uint256) {
        return entryPoint.getNonce(address(this), 0);
    }

    function _requireOwnerOrEntryPoint() private view {
        if (msg.sender != address(entryPoint) && msg.sender != owner) revert NotOwnerOrEntryPoint();
    }

    function _call(address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(result);
        emit Executed(target, value, data);
    }
}
