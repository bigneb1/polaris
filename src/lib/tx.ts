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
} from "./contracts";

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

/**
 * Ensure `spender` has at least `amount` USDC allowance from `owner`; approves
 * the exact amount if not. Returns the approval tx hash when one was sent.
 */
export async function ensureAllowance(
  owner: Address,
  spender: Address,
  amount: number,
): Promise<Hash | null> {
  const need = usdc(amount);
  const current = (await readContract(wagmiConfig, {
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (current >= need) return null;
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, need],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
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

/** Approve escrow, then submit the task (locks USDC). Returns the submit hash. */
export async function submitTask(i: SubmitTaskInput): Promise<Hash> {
  await ensureAllowance(i.owner, CONTRACTS.usdcEscrow, i.budgetUsdc);
  const hash = await writeContract(wagmiConfig, {
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
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

export async function registerAgent(input: {
  owner: Address;
  name: string;
  capabilities: string[];
  stakeUsdc: number;
}): Promise<Hash> {
  await ensureAllowance(input.owner, CONTRACTS.agentRegistry, input.stakeUsdc);
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.agentRegistry,
    abi: AGENT_REGISTRY_ABI,
    functionName: "register",
    args: [
      agentIdFrom(input.name, input.owner),
      usdc(input.stakeUsdc),
      input.name,
      input.capabilities.join(","),
    ],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

export async function setAgentOnline(online: boolean, restakeUsdc = 0, owner?: Address): Promise<Hash> {
  if (online) {
    if (restakeUsdc > 0 && owner) await ensureAllowance(owner, CONTRACTS.agentRegistry, restakeUsdc);
    const hash = await writeContract(wagmiConfig, {
      address: CONTRACTS.agentRegistry,
      abi: AGENT_REGISTRY_ABI,
      functionName: "restake",
      args: [usdc(restakeUsdc)],
    });
    await waitForTransactionReceipt(wagmiConfig, { hash });
    return hash;
  }
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.agentRegistry,
    abi: AGENT_REGISTRY_ABI,
    functionName: "deactivate",
    args: [],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

/** Reclaim the full stake - only valid when the agent is offline and idle. */
export async function withdrawStake(): Promise<Hash> {
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.agentRegistry,
    abi: AGENT_REGISTRY_ABI,
    functionName: "withdrawStake",
    args: [],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

export async function placeBid(
  taskId: `0x${string}`,
  bidUsdc: number,
  etaSeconds: number,
): Promise<Hash> {
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.bidEngine,
    abi: BID_ENGINE_ABI,
    functionName: "placeBid",
    args: [taskId, usdc(bidUsdc), BigInt(etaSeconds)],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

export async function awardBid(taskId: `0x${string}`): Promise<Hash> {
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.bidEngine,
    abi: BID_ENGINE_ABI,
    functionName: "awardBid",
    args: [taskId],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
}

export async function cancelTask(taskId: `0x${string}`): Promise<Hash> {
  const hash = await writeContract(wagmiConfig, {
    address: CONTRACTS.taskRegistry,
    abi: TASK_REGISTRY_ABI,
    functionName: "cancelTask",
    args: [taskId],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return hash;
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
