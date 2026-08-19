import {
  readContract,
  writeContract,
  waitForTransactionReceipt,
  switchChain,
  getAccount,
  getBalance,
  sendTransaction,
} from "wagmi/actions";
import { parseUnits, keccak256, stringToHex, type Address, type Hash } from "viem";
import { wagmiConfig } from "./chain";
import { resolveNetwork } from "./activeNetwork";
import { getNetwork, escrowAsset, type NetworkId } from "./networks";
import {
  requireContract,
  ERC20_ABI,
  TASK_REGISTRY_ABI,
  AGENT_REGISTRY_ABI,
  NATIVE_TASK_REGISTRY_ABI,
  NATIVE_AGENT_REGISTRY_ABI,
  BID_ENGINE_ABI,
  SUBSCRIPTION_MANAGER_ABI,
  DISPUTE_MANAGER_ABI,
  RECURRING_MARKET_ABI,
} from "./contracts";
import { circleWrite, type CircleSession } from "./circleWallet";
import { ucWrite, type UcSession } from "./circleUserWallet";

/** Either Circle wallet kind, or null/undefined for the wagmi path (Reown). */
export type Signer = CircleSession | UcSession | null | undefined;

/** Random bytes32 id for a new task. */
export function newTaskId(): `0x${string}` {
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

/** Deterministic bytes32 agent id from a name + wallet. */
export function agentIdFrom(name: string, wallet: string): `0x${string}` {
  return keccak256(stringToHex(`${name.toLowerCase()}:${wallet.toLowerCase()}`));
}

/**
 * Amount → on-chain units, using the ACTIVE network's escrow asset decimals
 * (6 for Arc's USDC, 18 for BOT Chain's native BOT). Always read from config,
 * never assumed: a 6-vs-18 mix-up silently moves 10^12 times the intended amount.
 */
const units = (amount: number | string, network?: NetworkId) =>
  parseUnits(String(amount), escrowAsset(network).decimals);

/**
 * True when the network settles in its own native coin (BOT Chain) rather than an
 * ERC-20 (Arc). Drives three differences: value travels as `msg.value`, there is
 * nothing to approve, and balances come from getBalance.
 */
const isNative = (network?: NetworkId) => escrowAsset(network).isNative;

/** The ERC-20 escrow token's address — only valid on non-native networks. */
function tokenAddress(network?: NetworkId): Address {
  const asset = escrowAsset(network);
  if (!asset.address) {
    throw new Error(`${asset.symbol} is this network's native coin, it has no token contract.`);
  }
  return asset.address;
}

/** Payable ABIs on native networks, the original ERC-20 ones on Arc. */
const taskRegistryAbi = (network?: NetworkId) => (isNative(network) ? NATIVE_TASK_REGISTRY_ABI : TASK_REGISTRY_ABI);
const agentRegistryAbi = (network?: NetworkId) => (isNative(network) ? NATIVE_AGENT_REGISTRY_ABI : AGENT_REGISTRY_ABI);

/* A single contract write description, used for both the wagmi and Circle paths.
 * `value` funds a payable call on a native network. */
type Write = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
};

/**
 * Execute a sequence of writes on `network`.
 *
 * With a passkey Circle session they are batched into one gasless user operation;
 * with a user-controlled (PIN) session each is signed in turn with the PIN;
 * otherwise each runs through the wallet connected via Reown.
 *
 * The wagmi path pins every transaction to the target chain id and switches
 * the wallet first, so a transaction can never be signed against whichever chain
 * the wallet happened to be on — the central wrong-chain hazard of a multi-chain
 * app.
 */
async function run(writes: Write[], signer?: Signer, network?: NetworkId): Promise<Hash> {
  const net = getNetwork(resolveNetwork(network));

  if (signer && "kind" in signer && signer.kind === "uc") {
    for (const w of writes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ucWrite(signer, w as any);
    }
    return "0x" as Hash; // PIN-signed challenges settle async; no single hash returned
  }
  if (signer) {
    // Circle wallets exist only on Arc, which is never native. Guard rather than
    // silently dropping the value and sending an unfunded call.
    if (writes.some((w) => w.value)) {
      throw new Error("Native-value transactions aren't supported by the Circle wallet path.");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return circleWrite(signer as CircleSession, writes as any);
  }

  // Reown-connected wallet: make sure it is actually on the network we're
  // writing to before signing anything.
  const account = getAccount(wagmiConfig);
  if (account.chainId !== net.chainId) {
    await switchChain(wagmiConfig, { chainId: net.chainId });
  }
  let last: Hash = "0x" as Hash;
  for (const w of writes) {
    last = await writeContract(wagmiConfig, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(w as any),
      chainId: net.chainId,
      // Only present on a native network's payable calls.
      ...(w.value ? { value: w.value } : {}),
    });
    await waitForTransactionReceipt(wagmiConfig, { hash: last, chainId: net.chainId });
  }
  return last;
}

/**
 * ERC-20 approvals, as a list so it can be empty. On a native network there is
 * nothing to approve, so posting a task or staking is ONE transaction instead of
 * two — which also removes the "approve mined but the create didn't" half-success
 * that `confirmCreated` below exists to catch.
 */
function approvals(spender: Address, amount: number, network?: NetworkId): Write[] {
  if (isNative(network)) return [];
  return [
    {
      address: tokenAddress(network),
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, units(amount, network)],
    },
  ];
}

/** `value` for a payable call on a native network; nothing on an ERC-20 one. */
const funding = (amount: number, network?: NetworkId) =>
  isNative(network) ? { value: units(amount, network) } : {};

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Poll an on-chain read until it reports the entity exists, or time out. This is
 * the safety net for "the tx confirmed but nothing happened": the approve+create
 * pair can leave only the approve mined (no USDC moves on approve), and the PIN
 * wallet settles async and returns no hash — both would otherwise look like a
 * success and navigate away. If the escrow never lands we throw so the UI shows a
 * real error instead of a phantom order.
 */
async function confirmCreated(check: () => Promise<boolean>, tries = 20, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return true;
    } catch {
      /* transient RPC error — keep polling */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export type SubmitTaskInput = {
  owner: Address;
  taskId: `0x${string}`;
  budgetUsdc: number;
  deadlineMs: number;
  minReputation: number;
  title: string;
  description: string;
  rubric: string;
  taskType: string;
};

/** Approve escrow + submit the task (locks the network's escrow asset). */
export async function submitTask(i: SubmitTaskInput, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [
      ...approvals(requireContract("usdcEscrow", network), i.budgetUsdc, network),
      {
        ...funding(i.budgetUsdc, network),
        address: requireContract("taskRegistry", network),
        abi: taskRegistryAbi(network),
        functionName: "submitTask",
        args: [
          i.taskId,
          units(i.budgetUsdc, network),
          BigInt(Math.floor(i.deadlineMs / 1000)),
          BigInt(i.minReputation),
          i.title,
          i.description,
          i.rubric,
          i.taskType,
        ],
      },
    ],
    circle,
    network,
  );
}

export async function registerAgent(
  input: { owner: Address; name: string; capabilities: string[]; stakeUsdc: number },
  circle?: Signer,
  network?: NetworkId,
): Promise<Hash> {
  return run(
    [
      ...approvals(requireContract("agentRegistry", network), input.stakeUsdc, network),
      {
        ...funding(input.stakeUsdc, network),
        address: requireContract("agentRegistry", network),
        abi: agentRegistryAbi(network),
        functionName: "register",
        args: [
          agentIdFrom(input.name, input.owner),
          units(input.stakeUsdc, network),
          input.name,
          input.capabilities.join(","),
        ],
      },
    ],
    circle,
    network,
  );
}

export async function setAgentOnline(
  online: boolean,
  restakeUsdc = 0,
  circle?: Signer,
  network?: NetworkId,
): Promise<Hash> {
  const agentRegistry = requireContract("agentRegistry", network);
  if (online) {
    const writes: Write[] = [];
    if (restakeUsdc > 0) writes.push(...approvals(agentRegistry, restakeUsdc, network));
    writes.push({
      ...funding(restakeUsdc, network),
      address: agentRegistry,
      abi: agentRegistryAbi(network),
      functionName: "restake",
      args: [units(restakeUsdc, network)],
    });
    return run(writes, circle, network);
  }
  return run(
    [{ address: agentRegistry, abi: agentRegistryAbi(network), functionName: "deactivate", args: [] }],
    circle,
    network,
  );
}

/** Reclaim the full stake - only valid when the agent is offline and idle. */
export async function withdrawStake(circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [{ address: requireContract("agentRegistry", network), abi: agentRegistryAbi(network), functionName: "withdrawStake", args: [] }],
    circle,
    network,
  );
}

export async function placeBid(
  taskId: `0x${string}`,
  bidUsdc: number,
  etaSeconds: number,
  circle?: Signer,
  network?: NetworkId,
): Promise<Hash> {
  return run(
    [
      {
        address: requireContract("bidEngine", network),
        abi: BID_ENGINE_ABI,
        functionName: "placeBid",
        args: [taskId, units(bidUsdc, network), BigInt(etaSeconds)],
      },
    ],
    circle,
    network,
  );
}

export async function awardBid(taskId: `0x${string}`, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [{ address: requireContract("bidEngine", network), abi: BID_ENGINE_ABI, functionName: "awardBid", args: [taskId] }],
    circle,
    network,
  );
}

export async function cancelTask(taskId: `0x${string}`, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [{ address: requireContract("taskRegistry", network), abi: taskRegistryAbi(network), functionName: "cancelTask", args: [taskId] }],
    circle,
    network,
  );
}

/* ── Recurring tasks / subscriptions (Phase A) ──────────────────────────────── */

export type CreateSubscriptionInput = {
  subId: `0x${string}`;
  agent: Address;
  perDeliveryUsdc: number;
  totalDeliveries: number;
  title: string;
  brief: string;
  rubric: string;
  taskType: string;
  schedule: string; // cadence string the runtime scheduler reads, e.g. "mon,wed,fri@09:00"
};

/** Approve the manager for the whole plan, then create + fully fund the subscription. */
export async function createSubscription(
  i: CreateSubscriptionInput,
  circle?: Signer,
  network?: NetworkId,
): Promise<Hash> {
  const manager = requireContract("subscriptionManager", network);
  const chainId = getNetwork(resolveNetwork(network)).chainId;
  const hash = await run(
    [
      ...approvals(manager, i.perDeliveryUsdc * i.totalDeliveries, network),
      {
        address: manager,
        // The whole plan is escrowed up front, so on a native network the total
        // travels with the call. Without this every subscription reverted on BOT
        // Chain with "Value must equal plan total" while looking fine on Arc.
        ...funding(i.perDeliveryUsdc * i.totalDeliveries, network),
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "createSubscription",
        args: [
          i.subId,
          i.agent,
          units(i.perDeliveryUsdc, network),
          i.totalDeliveries,
          { title: i.title, brief: i.brief, rubric: i.rubric, taskType: i.taskType, schedule: i.schedule },
        ],
      },
    ],
    circle,
    network,
  );
  const ok = await confirmCreated(async () => {
    const s = (await readContract(wagmiConfig, {
      address: manager,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: "getSubscription",
      args: [i.subId],
      chainId,
    })) as readonly [Address, ...unknown[]];
    return !!s?.[0] && s[0].toLowerCase() !== ZERO_ADDR; // [0] = subscriber
  });
  if (!ok)
    throw new Error(
      `Escrow didn't complete, no ${escrowAsset(network).symbol} was deducted. Make sure you have enough ${escrowAsset(network).symbol} and approve BOTH wallet prompts (allowance, then create), then try again.`,
    );
  return hash;
}

/* ── Recurring market (auctioned recurring plan) ─────────────────────────────── */
export type CreatePlanInput = {
  planId: `0x${string}`;
  perDeliveryUsdc: number;
  totalDeliveries: number;
  minReputation: number;
  title: string;
  brief: string;
  rubric: string;
  taskType: string;
  schedule: string;
};
/** Escrow the whole plan and post it to the market for agents to bid on. */
export async function createPlan(i: CreatePlanInput, circle?: Signer, network?: NetworkId): Promise<Hash> {
  const market = requireContract("recurringMarket", network);
  const chainId = getNetwork(resolveNetwork(network)).chainId;
  const hash = await run(
    [
      ...approvals(market, i.perDeliveryUsdc * i.totalDeliveries, network),
      {
        address: market,
        // Same as a subscription: the funded ceiling for every delivery is escrowed
        // at creation, so a native network needs it as msg.value.
        ...funding(i.perDeliveryUsdc * i.totalDeliveries, network),
        abi: RECURRING_MARKET_ABI,
        functionName: "createPlan",
        args: [
          i.planId,
          units(i.perDeliveryUsdc, network),
          i.totalDeliveries,
          BigInt(i.minReputation),
          { title: i.title, brief: i.brief, rubric: i.rubric, taskType: i.taskType, schedule: i.schedule },
        ],
      },
    ],
    circle,
    network,
  );
  const ok = await confirmCreated(async () => {
    const p = (await readContract(wagmiConfig, {
      address: market,
      abi: RECURRING_MARKET_ABI,
      functionName: "getPlan",
      args: [i.planId],
      chainId,
    })) as readonly [Address, ...unknown[]];
    return !!p?.[0] && p[0].toLowerCase() !== ZERO_ADDR; // [0] = requester
  });
  if (!ok)
    throw new Error(
      `Escrow didn't complete, no ${escrowAsset(network).symbol} was deducted. Make sure you have enough ${escrowAsset(network).symbol} and approve BOTH wallet prompts (allowance, then create), then try again.`,
    );
  return hash;
}
export async function cancelPlan(planId: `0x${string}`, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [{ address: requireContract("recurringMarket", network), abi: RECURRING_MARKET_ABI, functionName: "cancelPlan", args: [planId] }],
    circle,
    network,
  );
}

/** Cancel a subscription and refund the remaining (undelivered) escrow. */
export async function cancelSubscription(subId: `0x${string}`, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [
      {
        address: requireContract("subscriptionManager", network),
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "cancelSubscription",
        args: [subId],
      },
    ],
    circle,
    network,
  );
}

/* ── Disputes (Phase C) ─────────────────────────────────────────────────────── */

/** Open a staked dispute on a settled task (approve the bond, then open). */
export async function openDispute(
  i: { disputeId: `0x${string}`; taskId: `0x${string}`; agent: Address; bondUsdc: number; reason: string },
  circle?: Signer,
  network?: NetworkId,
): Promise<Hash> {
  const manager = requireContract("disputeManager", network);
  return run(
    [
      ...approvals(manager, i.bondUsdc, network),
      {
        address: manager,
        // The dispute bond is staked with the call on a native network.
        ...funding(i.bondUsdc, network),
        abi: DISPUTE_MANAGER_ABI,
        functionName: "openDispute",
        args: [i.disputeId, i.taskId, i.agent, units(i.bondUsdc, network), i.reason],
      },
    ],
    circle,
    network,
  );
}

export type HireInput = {
  agent: Address;
  taskId: `0x${string}`;
  budgetUsdc: number;
  deadlineMs: number;
  title: string;
  description: string;
  rubric: string;
  taskType: string;
};

/** Directly hire a specific agent (no auction): approve escrow + submitDirectTask. */
export async function hireAgent(i: HireInput, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return run(
    [
      ...approvals(requireContract("usdcEscrow", network), i.budgetUsdc, network),
      {
        ...funding(i.budgetUsdc, network),
        address: requireContract("taskRegistry", network),
        abi: taskRegistryAbi(network),
        functionName: "submitDirectTask",
        args: [
          i.taskId,
          i.agent,
          units(i.budgetUsdc, network),
          BigInt(Math.floor(i.deadlineMs / 1000)),
          i.title,
          i.description,
          i.rubric,
          i.taskType,
        ],
      },
    ],
    circle,
    network,
  );
}

/** Add to an agent's stake (approve + restake). */
export async function addStake(amountUsdc: number, circle?: Signer, network?: NetworkId): Promise<Hash> {
  const agentRegistry = requireContract("agentRegistry", network);
  return run(
    [
      ...approvals(agentRegistry, amountUsdc, network),
      {
        ...funding(amountUsdc, network),
        address: agentRegistry,
        abi: agentRegistryAbi(network),
        functionName: "restake",
        args: [units(amountUsdc, network)],
      },
    ],
    circle,
    network,
  );
}

/**
 * Move the escrow asset to any address: an ERC-20 `transfer` on Arc, a plain value
 * transfer on a native network.
 */
async function sendAsset(to: Address, amount: number, circle?: Signer, network?: NetworkId): Promise<Hash> {
  const net = getNetwork(resolveNetwork(network));
  if (isNative(network)) {
    if (circle) throw new Error("Native transfers aren't supported by the Circle wallet path.");
    const account = getAccount(wagmiConfig);
    if (account.chainId !== net.chainId) await switchChain(wagmiConfig, { chainId: net.chainId });
    const hash = await sendTransaction(wagmiConfig, {
      to,
      value: units(amount, network),
      chainId: net.chainId,
    });
    await waitForTransactionReceipt(wagmiConfig, { hash, chainId: net.chainId });
    return hash;
  }
  return run(
    [
      {
        address: tokenAddress(network),
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to, units(amount, network)],
      },
    ],
    circle,
    network,
  );
}

/** Wire (transfer) the escrow asset directly to any address. */
export async function wireUsdc(to: Address, amountUsdc: number, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return sendAsset(to, amountUsdc, circle, network);
}

/** Withdraw / transfer the escrow asset from the connected wallet to any address. */
export async function transferUsdc(to: Address, amount: number, circle?: Signer, network?: NetworkId): Promise<Hash> {
  return sendAsset(to, amount, circle, network);
}

/** Read the escrow-asset balance (human units) for an address: the native coin
 *  balance on a native network, the ERC-20 balance otherwise. */
export async function usdcBalance(addr: Address, network?: NetworkId): Promise<number> {
  const asset = escrowAsset(network);
  const chainId = getNetwork(resolveNetwork(network)).chainId;
  if (asset.isNative) {
    const bal = await getBalance(wagmiConfig, { address: addr, chainId });
    return Number(bal.value) / 10 ** asset.decimals;
  }
  const raw = (await readContract(wagmiConfig, {
    address: tokenAddress(network),
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [addr],
    chainId,
  })) as bigint;
  return Number(raw) / 10 ** asset.decimals;
}
