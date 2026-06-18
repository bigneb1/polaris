import { useQuery } from "@tanstack/react-query";
import { usePublicClient, type UsePublicClientReturnType } from "wagmi";
import {
  decodeEventLog,
  formatUnits,
  hexToString,
  type AbiEvent,
  type Address,
  type Log,
} from "viem";
import {
  CONTRACTS,
  TASK_REGISTRY_ABI,
  AGENT_REGISTRY_ABI,
  BID_ENGINE_ABI,
  VERIFIER_BRIDGE_ABI,
  coreDeployed,
} from "./contracts";
import { USDC_DECIMALS } from "./chain";
import type { Task, Agent, Bid, ActivityEvent, MarketStats, TaskStatus } from "./types";

type Client = NonNullable<UsePublicClientReturnType>;

/* ── Indexing window ─────────────────────────────────────────────────────────
 * Scanning eth_getLogs from genesis on a public RPC times out / returns huge
 * payloads. We scan a bounded recent window in chunks (same approach proven in
 * the SynapseMesh indexer). Override via env for deep history.
 */
const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const FROM_BLOCK = ENV.VITE_INDEX_FROM_BLOCK ? BigInt(ENV.VITE_INDEX_FROM_BLOCK) : null;
const LOOKBACK = BigInt(ENV.VITE_INDEX_LOOKBACK_BLOCKS || "500000");
// Arc public RPC caps eth_getLogs at a 10,000-block range, so we must stay
// strictly under it or every windowed query silently fails and the UI shows no
// agents/tasks. We HARD-CAP at 9000 regardless of the env value so a stale or
// misconfigured deployment (e.g. VITE_INDEX_CHUNK_BLOCKS=10000) can't break it.
const MAX_CHUNK = 9000n;
const CHUNK = (() => {
  try {
    const v = BigInt(ENV.VITE_INDEX_CHUNK_BLOCKS || "9000");
    return v > MAX_CHUNK || v < 1n ? MAX_CHUNK : v;
  } catch {
    return MAX_CHUNK;
  }
})();
const REFETCH_MS = 8000;

function toUsdc(raw: bigint): number {
  return Number(formatUnits(raw, USDC_DECIMALS));
}

/** Short human ref from a bytes32 task id. */
function refOf(taskId: string): string {
  return taskId.slice(2, 10).toUpperCase();
}

/** bytes32 → trimmed utf8 string (agent ids are stored as bytes32). */
function bytes32ToStr(b: string): string {
  try {
    return hexToString(b as `0x${string}`, { size: 32 }).replace(/\0+$/, "");
  } catch {
    return b.slice(0, 10);
  }
}

async function getLogsWindowed(
  client: Client,
  address: Address,
  events: AbiEvent[],
): Promise<Log[]> {
  if (address === ("0x" as Address)) return [];
  const head = await client.getBlockNumber();
  const start = FROM_BLOCK ?? (head > LOOKBACK ? head - LOOKBACK : 0n);
  const out: Log[] = [];
  for (let from = start; from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    try {
      const logs = await client.getLogs({ address, events, fromBlock: from, toBlock: to });
      out.push(...logs);
    } catch {
      // RPC chunk failed (rate limit / range cap) - skip; next refetch retries.
    }
  }
  return out;
}

/** Fetch block timestamps for a set of block numbers, deduped + capped. */
async function blockTimes(client: Client, blocks: bigint[]): Promise<Map<bigint, number>> {
  const uniq = Array.from(new Set(blocks)).slice(-400); // cap RPC fan-out
  const map = new Map<bigint, number>();
  await Promise.all(
    uniq.map(async (bn) => {
      try {
        const blk = await client.getBlock({ blockNumber: bn });
        map.set(bn, Number(blk.timestamp) * 1000);
      } catch {
        /* ignore */
      }
    }),
  );
  return map;
}

function decode(log: Log, abi: readonly unknown[]) {
  try {
    return decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

/* ── Core indexer: pull all logs once, fold into domain objects ──────────────── */

async function indexAll(client: Client) {
  const [taskLogs, agentLogs, bidLogs, verifierLogs] = await Promise.all([
    getLogsWindowed(client, CONTRACTS.taskRegistry, TASK_REGISTRY_ABI as unknown as AbiEvent[]),
    getLogsWindowed(client, CONTRACTS.agentRegistry, AGENT_REGISTRY_ABI as unknown as AbiEvent[]),
    getLogsWindowed(client, CONTRACTS.bidEngine, BID_ENGINE_ABI as unknown as AbiEvent[]),
    getLogsWindowed(client, CONTRACTS.verifierBridge, VERIFIER_BRIDGE_ABI as unknown as AbiEvent[]),
  ]);

  const allBlocks = [...taskLogs, ...agentLogs, ...bidLogs]
    .map((l) => l.blockNumber)
    .filter((b): b is bigint => b !== null);
  const times = await blockTimes(client, allBlocks);
  const tsOf = (log: Log) => (log.blockNumber ? times.get(log.blockNumber) ?? Date.now() : Date.now());

  /* Tasks */
  const tasks = new Map<string, Task>();
  for (const log of taskLogs) {
    const ev = decode(log, TASK_REGISTRY_ABI);
    if (!ev) continue;
    const a = ev.args as unknown as Record<string, unknown>;
    const id = a.taskId as `0x${string}`;
    const atMs = tsOf(log);
    if (ev.eventName === "TaskSubmitted") {
      tasks.set(id, {
        taskId: id,
        ref: refOf(id),
        requester: a.requester as Address,
        budgetUsdc: toUsdc(a.budgetUsdc as bigint),
        deadlineMs: Number(a.deadline as bigint) * 1000,
        minReputation: Number(a.minReputation as bigint),
        title: (a.title as string) || "Untitled task",
        description: (a.description as string) || "",
        rubric: (a.rubric as string) || "",
        taskType: (a.taskType as string) || "general",
        status: "OPEN",
        createdAtMs: atMs,
        txHash: log.transactionHash as `0x${string}`,
      });
    } else if (ev.eventName === "TaskAssigned") {
      const t = tasks.get(id);
      if (t) {
        t.status = "ASSIGNED";
        t.assignedAgent = a.agent as Address;
        t.winningBid = toUsdc(a.bidAmount as bigint);
      }
    } else if (ev.eventName === "TaskSettled") {
      const t = tasks.get(id);
      if (t) t.status = "SETTLED";
    } else if (ev.eventName === "TaskCancelled") {
      const t = tasks.get(id);
      if (t) t.status = "CANCELLED";
    }
  }

  /* Onchain settlement attestations (VerifierBridge.VerificationSubmitted) */
  for (const log of verifierLogs) {
    const ev = decode(log, VERIFIER_BRIDGE_ABI);
    if (!ev || ev.eventName !== "VerificationSubmitted") continue;
    const a = ev.args as unknown as Record<string, unknown>;
    const t = tasks.get(a.taskId as `0x${string}`);
    if (t) {
      t.attestation = {
        score: Number(a.score as bigint),
        passed: a.passed as boolean,
        deliverableHash: a.deliverableHash as `0x${string}`,
      };
    }
  }

  /* Bids */
  const bids: Bid[] = [];
  const awarded = new Map<string, Address>();
  for (const log of bidLogs) {
    const ev = decode(log, BID_ENGINE_ABI);
    if (!ev) continue;
    const a = ev.args as unknown as Record<string, unknown>;
    if (ev.eventName === "BidPlaced") {
      bids.push({
        taskId: a.taskId as `0x${string}`,
        agent: a.agent as Address,
        amount: toUsdc(a.amount as bigint),
        score: Number(a.score as bigint),
        etaSeconds: Number(a.etaSeconds as bigint),
        won: false,
        atMs: tsOf(log),
      });
    } else if (ev.eventName === "BidAwarded") {
      awarded.set(a.taskId as string, a.winner as Address);
    }
  }
  for (const b of bids) {
    if (awarded.get(b.taskId)?.toLowerCase() === b.agent.toLowerCase()) b.won = true;
  }

  /* Agents */
  const agents = new Map<string, Agent>();
  for (const log of agentLogs) {
    const ev = decode(log, AGENT_REGISTRY_ABI);
    if (!ev) continue;
    const a = ev.args as unknown as Record<string, unknown>;
    const wallet = (a.wallet as Address)?.toLowerCase() as Address;
    if (ev.eventName === "AgentRegistered") {
      agents.set(wallet, {
        wallet: a.wallet as Address,
        agentId: a.agentId as `0x${string}`,
        name: (a.name as string) || bytes32ToStr(a.agentId as string),
        capabilities: ((a.capabilities as string) || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        stakeUsdc: toUsdc(a.stake as bigint),
        reputation: 500,
        tasksCompleted: 0,
        tasksFailed: 0,
        totalEarned: 0,
        online: true,
        slashed: false,
        createdAtMs: tsOf(log),
      });
    } else {
      const ag = agents.get(wallet);
      if (!ag) continue;
      if (ev.eventName === "ReputationUpdated") ag.reputation = Number(a.newRep as bigint);
      else if (ev.eventName === "AgentDeactivated") ag.online = false;
      else if (ev.eventName === "StakeWithdrawn") {
        ag.online = false;
        ag.stakeUsdc = 0;
      } else if (ev.eventName === "AgentRestaked") {
        ag.online = true;
        ag.stakeUsdc = toUsdc(a.amount as bigint);
      } else if (ev.eventName === "AgentSlashed") {
        ag.slashed = true;
        ag.tasksFailed += 1;
      }
    }
  }

  /* Derive agent throughput + earnings from settled tasks */
  for (const t of tasks.values()) {
    if (t.status === "SETTLED" && t.assignedAgent) {
      const ag = agents.get(t.assignedAgent.toLowerCase() as Address);
      if (ag) {
        ag.tasksCompleted += 1;
        ag.totalEarned += t.winningBid ?? t.budgetUsdc;
      }
    }
  }

  /* Activity feed (most recent first) */
  const activity: ActivityEvent[] = [];
  for (const t of tasks.values()) {
    activity.push({
      id: `task-${t.taskId}`,
      kind: "TASK_POSTED",
      title: `Task posted · ${t.title}`,
      detail: t.taskType,
      amountUsdc: t.budgetUsdc,
      wallet: t.requester,
      txHash: t.txHash,
      atMs: t.createdAtMs,
    });
    if (t.status === "SETTLED" && t.assignedAgent) {
      activity.push({
        id: `settle-${t.taskId}`,
        kind: "TASK_SETTLED",
        title: `Settled · ${t.title}`,
        amountUsdc: t.winningBid ?? t.budgetUsdc,
        wallet: t.assignedAgent,
        txHash: t.txHash,
        atMs: t.createdAtMs + 1,
      });
    }
  }
  for (const b of bids) {
    activity.push({
      id: `bid-${b.taskId}-${b.agent}-${b.atMs}`,
      kind: "BID_PLACED",
      title: `Bid placed`,
      detail: refOf(b.taskId),
      amountUsdc: b.amount,
      wallet: b.agent,
      txHash: "0x" as `0x${string}`,
      atMs: b.atMs,
    });
  }
  for (const ag of agents.values()) {
    activity.push({
      id: `agent-${ag.wallet}`,
      kind: "AGENT_REGISTERED",
      title: `Agent registered · ${ag.name}`,
      wallet: ag.wallet,
      txHash: "0x" as `0x${string}`,
      atMs: ag.createdAtMs,
    });
  }
  activity.sort((x, y) => y.atMs - x.atMs);

  return {
    tasks: Array.from(tasks.values()).sort((a, b) => b.createdAtMs - a.createdAtMs),
    agents: Array.from(agents.values()).sort((a, b) => b.reputation - a.reputation),
    bids,
    activity: activity.slice(0, 60),
  };
}

/* ── Hooks ───────────────────────────────────────────────────────────────────*/

function useIndex() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["polaris-index", CONTRACTS.taskRegistry, CONTRACTS.agentRegistry],
    enabled: !!client && coreDeployed(),
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      if (!client) throw new Error("no client");
      return indexAll(client);
    },
  });
}

export function useTasks() {
  const q = useIndex();
  return { tasks: q.data?.tasks ?? [], isLoading: q.isLoading, error: q.error };
}

export function useTask(taskId?: string) {
  const q = useIndex();
  const task = q.data?.tasks.find((t) => t.taskId.toLowerCase() === taskId?.toLowerCase());
  const bids = (q.data?.bids ?? [])
    .filter((b) => b.taskId.toLowerCase() === taskId?.toLowerCase())
    .sort((a, b) => b.score - a.score);
  return { task, bids, isLoading: q.isLoading };
}

export function useAgents() {
  const q = useIndex();
  return { agents: q.data?.agents ?? [], isLoading: q.isLoading };
}

/** A single agent + every task it has been assigned (current + completed). */
export function useAgent(wallet?: string) {
  const q = useIndex();
  const w = wallet?.toLowerCase();
  const agent = q.data?.agents.find((a) => a.wallet.toLowerCase() === w);
  const tasks = (q.data?.tasks ?? [])
    .filter((t) => t.assignedAgent?.toLowerCase() === w)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { agent, tasks, isLoading: q.isLoading };
}

export function useActivity() {
  const q = useIndex();
  return { activity: q.data?.activity ?? [], isLoading: q.isLoading };
}

export function useMarketStats(): { stats: MarketStats; isLoading: boolean } {
  const q = useIndex();
  const tasks = q.data?.tasks ?? [];
  const agents = q.data?.agents ?? [];
  const dayAgo = Date.now() - 86400_000;
  const openStatuses: TaskStatus[] = ["OPEN", "ASSIGNED", "IN_PROGRESS", "COMPLETED"];
  const stats: MarketStats = {
    openTasks: tasks.filter((t) => t.status === "OPEN").length,
    escrowUsdc: tasks
      .filter((t) => openStatuses.includes(t.status))
      .reduce((s, t) => s + t.budgetUsdc, 0),
    activeAgents: agents.filter((a) => a.online).length,
    settledToday: tasks.filter((t) => t.status === "SETTLED" && t.createdAtMs >= dayAgo).length,
    totalSettledUsdc: tasks
      .filter((t) => t.status === "SETTLED")
      .reduce((s, t) => s + (t.winningBid ?? t.budgetUsdc), 0),
  };
  return { stats, isLoading: q.isLoading };
}
