import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { parseUnits, keccak256, stringToHex, type Address, type Hash } from "viem";
import { wagmiConfig } from "./chain";
import { USDC_DECIMALS } from "./chain";
import {
  CONTRACTS,
  ERC20_ABI,
  TASK_REGISTRY_ABI,
  AGENT_REGISTRY_ABI,
  BID_ENGINE_ABI,
  SUBSCRIPTION_MANAGER_ABI,
} from "./contracts";
import { circleWrite, type CircleSession } from "./circleWallet";
import { ucWrite, type UcSession } from "./circleUserWallet";

/** Either Circle wallet kind, or null/undefined for the injected-wallet path. */
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

const usdc = (amount: number | string) => parseUnits(String(amount), USDC_DECIMALS);

/* A single contract write description, used for both the wagmi and Circle paths. */
type Write = { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] };

/**
 * Execute a sequence of writes. With a passkey Circle session they are batched
 * into one gasless user operation; with a user-controlled (PIN) session each is
 * signed in turn with the PIN; otherwise each runs through the injected wallet.
 */
async function run(writes: Write[], signer?: Signer): Promise<Hash> {
  if (signer && "kind" in signer && signer.kind === "uc") {
    for (const w of writes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ucWrite(signer, w as any);
    }
    return "0x" as Hash; // PIN-signed challenges settle async; no single hash returned
  }
  if (signer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return circleWrite(signer as CircleSession, writes as any);
  }
  let last: Hash = "0x" as Hash;
  for (const w of writes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    last = await writeContract(wagmiConfig, w as any);
    await waitForTransactionReceipt(wagmiConfig, { hash: last });
  }
  return last;
}

const approve = (spender: Address, amount: number): Write => ({
  address: CONTRACTS.usdc,
  abi: ERC20_ABI,
  functionName: "approve",
  args: [spender, usdc(amount)],
});

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

/** Approve escrow + submit the task (locks USDC). */
export async function submitTask(i: SubmitTaskInput, circle?: Signer): Promise<Hash> {
  return run(
    [
      approve(CONTRACTS.usdcEscrow, i.budgetUsdc),
      {
        address: CONTRACTS.taskRegistry,
        abi: TASK_REGISTRY_ABI,
        functionName: "submitTask",
        args: [
          i.taskId,
          usdc(i.budgetUsdc),
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
  );
}

export async function registerAgent(
  input: { owner: Address; name: string; capabilities: string[]; stakeUsdc: number },
  circle?: Signer,
): Promise<Hash> {
  return run(
    [
      approve(CONTRACTS.agentRegistry, input.stakeUsdc),
      {
        address: CONTRACTS.agentRegistry,
        abi: AGENT_REGISTRY_ABI,
        functionName: "register",
        args: [agentIdFrom(input.name, input.owner), usdc(input.stakeUsdc), input.name, input.capabilities.join(",")],
      },
    ],
    circle,
  );
}

export async function setAgentOnline(
  online: boolean,
  restakeUsdc = 0,
  circle?: Signer,
): Promise<Hash> {
  if (online) {
    const writes: Write[] = [];
    if (restakeUsdc > 0) writes.push(approve(CONTRACTS.agentRegistry, restakeUsdc));
    writes.push({ address: CONTRACTS.agentRegistry, abi: AGENT_REGISTRY_ABI, functionName: "restake", args: [usdc(restakeUsdc)] });
    return run(writes, circle);
  }
  return run([{ address: CONTRACTS.agentRegistry, abi: AGENT_REGISTRY_ABI, functionName: "deactivate", args: [] }], circle);
}

/** Reclaim the full stake - only valid when the agent is offline and idle. */
export async function withdrawStake(circle?: Signer): Promise<Hash> {
  return run([{ address: CONTRACTS.agentRegistry, abi: AGENT_REGISTRY_ABI, functionName: "withdrawStake", args: [] }], circle);
}

export async function placeBid(
  taskId: `0x${string}`,
  bidUsdc: number,
  etaSeconds: number,
  circle?: Signer,
): Promise<Hash> {
  return run([{ address: CONTRACTS.bidEngine, abi: BID_ENGINE_ABI, functionName: "placeBid", args: [taskId, usdc(bidUsdc), BigInt(etaSeconds)] }], circle);
}

export async function awardBid(taskId: `0x${string}`, circle?: Signer): Promise<Hash> {
  return run([{ address: CONTRACTS.bidEngine, abi: BID_ENGINE_ABI, functionName: "awardBid", args: [taskId] }], circle);
}

export async function cancelTask(taskId: `0x${string}`, circle?: Signer): Promise<Hash> {
  return run([{ address: CONTRACTS.taskRegistry, abi: TASK_REGISTRY_ABI, functionName: "cancelTask", args: [taskId] }], circle);
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
export async function createSubscription(i: CreateSubscriptionInput, circle?: Signer): Promise<Hash> {
  return run(
    [
      approve(CONTRACTS.subscriptionManager, i.perDeliveryUsdc * i.totalDeliveries),
      {
        address: CONTRACTS.subscriptionManager,
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "createSubscription",
        args: [
          i.subId,
          i.agent,
          usdc(i.perDeliveryUsdc),
          i.totalDeliveries,
          { title: i.title, brief: i.brief, rubric: i.rubric, taskType: i.taskType, schedule: i.schedule },
        ],
      },
    ],
    circle,
  );
}

/** Cancel a subscription and refund the remaining (undelivered) escrow. */
export async function cancelSubscription(subId: `0x${string}`, circle?: Signer): Promise<Hash> {
  return run(
    [{ address: CONTRACTS.subscriptionManager, abi: SUBSCRIPTION_MANAGER_ABI, functionName: "cancelSubscription", args: [subId] }],
    circle,
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
export async function hireAgent(i: HireInput, circle?: Signer): Promise<Hash> {
  return run(
    [
      approve(CONTRACTS.usdcEscrow, i.budgetUsdc),
      {
        address: CONTRACTS.taskRegistry,
        abi: TASK_REGISTRY_ABI,
        functionName: "submitDirectTask",
        args: [
          i.taskId,
          i.agent,
          usdc(i.budgetUsdc),
          BigInt(Math.floor(i.deadlineMs / 1000)),
          i.title,
          i.description,
          i.rubric,
          i.taskType,
        ],
      },
    ],
    circle,
  );
}

/** Add to an agent's stake (approve + restake). */
export async function addStake(amountUsdc: number, circle?: Signer): Promise<Hash> {
  return run(
    [
      approve(CONTRACTS.agentRegistry, amountUsdc),
      { address: CONTRACTS.agentRegistry, abi: AGENT_REGISTRY_ABI, functionName: "restake", args: [usdc(amountUsdc)] },
    ],
    circle,
  );
}

/** Wire (transfer) USDC directly to any address. */
export async function wireUsdc(to: Address, amountUsdc: number, circle?: Signer): Promise<Hash> {
  return run(
    [{ address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "transfer", args: [to, usdc(amountUsdc)] }],
    circle,
  );
}

/** Read onchain USDC balance (human units) for an address. */
export async function usdcBalance(addr: Address): Promise<number> {
  const raw = (await readContract(wagmiConfig, {
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
  return Number(raw) / 10 ** USDC_DECIMALS;
}
