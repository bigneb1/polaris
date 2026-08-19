import { ethers } from "ethers";

/**
 * ERC-4337 v0.7 self-bundling.
 *
 * BOT Chain has the canonical EntryPoint deployed (byte-identical to Ethereum's)
 * but **no public bundler**: `eth_supportedEntryPoints` answers -32601, and the
 * chain's own gas sponsorship is an EOA/builder scheme explicitly distinct from
 * 4337's paymaster. So there is nobody to send a UserOperation to. Polaris
 * therefore bundles for itself: build the operation, have the account's owner key
 * sign it, and call `EntryPoint.handleOps` from a relayer EOA.
 *
 * That is a real 4337 flow, not a lookalike. The EntryPoint validates the account's
 * signature, charges the account's deposit for gas, and emits `UserOperationEvent`.
 * What Polaris skips is the third-party bundler's mempool and reputation system,
 * because on this chain there is none to join.
 *
 * WHAT THE RELAYER IS AND IS NOT. It pays the transaction that carries the bundle
 * and is refunded by the EntryPoint from the account's deposit, so it needs gas but
 * takes no custody: it cannot alter the calls, since the account's signature covers
 * them. A misbehaving relayer can only fail to submit, which is why every agent
 * keeps a direct-call fallback.
 *
 * GAS LIMITS. With no bundler there is no `eth_estimateUserOperationGas`, so limits
 * are estimated the only way available: simulate the inner call with `eth_estimateGas`
 * from the account, then add fixed room for validation and the EntryPoint's own
 * overhead. Over-estimating costs the account a little unused prefund (refunded);
 * under-estimating fails the operation, so the padding is deliberately generous.
 */

const ENTRY_POINT_ABI = [
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function depositTo(address account) payable",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
];

const ACCOUNT_ABI = [
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] datas)",
  "function owner() view returns (address)",
  "function addDeposit() payable",
  "function depositBalance() view returns (uint256)",
];

const FACTORY_ABI = [
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
];

/**
 * Ask the factory for a counterfactual account address.
 *
 * MUST use the explicit signature: ethers' `BaseContract` has its own
 * `getAddress()` that returns the CONTRACT's address, and it shadows the Solidity
 * `getAddress(address,uint256)` of the same name. Calling `factory.getAddress(owner,
 * salt)` silently ignores the arguments and hands back the factory's own address,
 * which then looks like a deployed account that rejects every call. The canonical
 * SimpleAccountFactory uses this name too, so the shadow is worth guarding once
 * here rather than remembering at each call site.
 */
function predictAddress(factory, owner, salt) {
  return factory["getAddress(address,uint256)"](owner, salt);
}

/** Two 128-bit values packed into one word, as v0.7 does for gas fields. */
function pack(hi, lo) {
  return ethers.solidityPacked(["uint128", "uint128"], [hi, lo]);
}

export function bundlingAvailable(ctx) {
  return Boolean(ctx.ADDR.entryPoint && ctx.ADDR.accountFactory);
}

export function entryPointOf(ctx, signerOrProvider) {
  return new ethers.Contract(ctx.ADDR.entryPoint, ENTRY_POINT_ABI, signerOrProvider ?? ctx.provider);
}

export function accountOf(ctx, address, signerOrProvider) {
  return new ethers.Contract(address, ACCOUNT_ABI, signerOrProvider ?? ctx.provider);
}

/** The deterministic account address for an owner, whether or not it exists yet. */
export async function accountAddress(ctx, owner, salt = 0) {
  if (!bundlingAvailable(ctx)) return null;
  const factory = new ethers.Contract(ctx.ADDR.accountFactory, FACTORY_ABI, ctx.provider);
  return predictAddress(factory, owner, salt);
}

/**
 * Ensure the agent's smart account exists and holds enough EntryPoint deposit to
 * pay for its own operations.
 *
 * Deployed by the relayer rather than through `initCode`, deliberately: a plain
 * `createAccount` call gives a clear revert if something is wrong, whereas a failed
 * first-operation-with-initCode surfaces as an opaque AA1x code. The address is
 * identical either way because it is CREATE2-derived.
 */
export async function ensureAccount(ctx, relayer, owner, { salt = 0, deposit = "0.02" } = {}) {
  if (!bundlingAvailable(ctx)) return null;
  const factory = new ethers.Contract(ctx.ADDR.accountFactory, FACTORY_ABI, relayer);
  const address = await predictAddress(factory, owner, salt);
  const code = await ctx.provider.getCode(address);
  if (code === "0x") {
    await (await factory.createAccount(owner, salt)).wait();
    console.log(`[4337:${ctx.id}] account ${address} deployed for owner ${owner}`);
  }
  const ep = entryPointOf(ctx, relayer);
  const target = ethers.parseEther(String(deposit));
  const balance = await ep.balanceOf(address);
  if (balance < target) {
    const top = target - balance;
    await (await ep.depositTo(address, { value: top })).wait();
    console.log(`[4337:${ctx.id}] deposited ${ethers.formatEther(top)} for ${address}`);
  }
  return address;
}

/**
 * Build, sign and submit a UserOperation carrying one or more calls.
 *
 * `calls` is `[{ to, value, data }]`. A single call goes through `execute`, several
 * through `executeBatch`, so a bid-then-submit sequence lands atomically.
 *
 * Returns the receipt plus the operation's own success flag: `handleOps` succeeds as
 * a transaction even when the inner call reverts (the EntryPoint records that in
 * `UserOperationEvent.success` and charges for it), so callers must not read a
 * successful receipt as a successful operation. That distinction is the single
 * easiest thing to get wrong with 4337.
 */
export async function sendUserOperation(ctx, { accountAddress: account, ownerSigner, relayer, calls, gasBuffer = 60000n }) {
  if (!bundlingAvailable(ctx)) throw new Error(`ERC-4337 is not configured for ${ctx.label}`);
  if (!calls?.length) throw new Error("No calls to send");

  const ep = entryPointOf(ctx, relayer);
  const acct = accountOf(ctx, account, ctx.provider);

  const callData =
    calls.length === 1
      ? acct.interface.encodeFunctionData("execute", [calls[0].to, calls[0].value ?? 0n, calls[0].data ?? "0x"])
      : acct.interface.encodeFunctionData("executeBatch", [
          calls.map((c) => c.to),
          calls.map((c) => c.value ?? 0n),
          calls.map((c) => c.data ?? "0x"),
        ]);

  // No bundler means no eth_estimateUserOperationGas, so simulate the call the
  // EntryPoint will make and add room for validation and overhead.
  //
  // `from` MUST be the EntryPoint: `execute` only accepts the EntryPoint or the
  // owner, so estimating with `from: account` reverts with NotOwnerOrEntryPoint and
  // silently falls back to the default limit (observed as `execution reverted:
  // 0x50a222f4` on a live run).
  let callGasLimit = 500000n;
  try {
    const estimated = await ctx.provider.estimateGas({
      from: ctx.ADDR.entryPoint,
      to: account,
      data: callData,
      value: 0n,
    });
    callGasLimit = estimated + gasBuffer;
  } catch (e) {
    console.warn(
      `[4337:${ctx.id}] inner gas estimate failed (${e.shortMessage || e.message}); using ${callGasLimit}`,
    );
  }

  const fee = await ctx.provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("20", "gwei");
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;

  const userOp = {
    sender: account,
    nonce: await ep.getNonce(account, 0),
    initCode: "0x",
    callData,
    accountGasLimits: pack(300000n, callGasLimit), // verification | call
    preVerificationGas: 100000n,
    gasFees: pack(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };

  // The EntryPoint computes the hash itself, so ask it rather than reimplementing
  // v0.7's packing: a mismatch here is an AA24 signature error with no clue why.
  const userOpHash = await ep.getUserOpHash(userOp);
  userOp.signature = await ownerSigner.signMessage(ethers.getBytes(userOpHash));

  const relayerAddress = await relayer.getAddress();
  const tx = await ep.handleOps([userOp], relayerAddress);
  const receipt = await tx.wait();

  // Read the operation's own outcome out of the logs.
  let success = null;
  let actualGasCost = null;
  let revertReason = null;
  for (const log of receipt.logs) {
    try {
      const parsed = ep.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "UserOperationEvent" && parsed.args.userOpHash === userOpHash) {
        success = parsed.args.success;
        actualGasCost = parsed.args.actualGasCost;
      }
      if (parsed?.name === "UserOperationRevertReason" && parsed.args.userOpHash === userOpHash) {
        revertReason = parsed.args.revertReason;
      }
    } catch {
      /* not an EntryPoint log */
    }
  }

  return { userOpHash, txHash: receipt.hash, success, actualGasCost, revertReason, receipt };
}
