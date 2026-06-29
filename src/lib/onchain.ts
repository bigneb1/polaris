import { useQuery } from "@tanstack/react-query";
import type { Task, Agent, Bid, ActivityEvent, MarketStats, TaskStatus, Subscription } from "./types";

/* ── Backend-served chain index ──────────────────────────────────────────────
 * The browser used to make ~220 sequential eth_getLogs calls against the public
 * Arc RPC per load (56 chunks x 4 contracts), which is fragile and rate-limited
 * in the browser and left the UI empty. The Railway runtime now indexes the
 * chain reliably and serves the result at /api/index; the chain remains the
 * single source of truth (no database). We just fetch that JSON here.
 */
const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const API_URL = ENV.VITE_API_URL || "https://polaris-agent-runtime-production.up.railway.app";
const REFETCH_MS = 8000;

type IndexResult = { tasks: Task[]; agents: Agent[]; bids: Bid[]; activity: ActivityEvent[] };

async function fetchIndex(): Promise<IndexResult> {
  const r = await fetch(`${API_URL}/api/index`);
  if (!r.ok) throw new Error(`index request failed (${r.status})`);
  const d = (await r.json()) as Partial<IndexResult>;
  return { tasks: d.tasks ?? [], agents: d.agents ?? [], bids: d.bids ?? [], activity: d.activity ?? [] };
}

/* ── Hooks ───────────────────────────────────────────────────────────────────*/

function useIndex() {
  return useQuery({
    queryKey: ["polaris-index"],
    refetchInterval: REFETCH_MS,
    queryFn: fetchIndex,
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

/* ── Subscriptions (recurring tasks) — served separately from the chain index ── */
async function fetchSubscriptions(): Promise<Subscription[]> {
  const r = await fetch(`${API_URL}/api/subscriptions`);
  if (!r.ok) throw new Error(`subscriptions request failed (${r.status})`);
  const d = (await r.json()) as { subscriptions?: Subscription[] };
  return d.subscriptions ?? [];
}

/** All subscriptions, optionally filtered to a subscriber or an agent wallet. */
export function useSubscriptions(filter?: { subscriber?: string; agent?: string }) {
  const q = useQuery({ queryKey: ["polaris-subscriptions"], refetchInterval: REFETCH_MS, queryFn: fetchSubscriptions });
  let subs = q.data ?? [];
  if (filter?.subscriber) subs = subs.filter((s) => s.subscriber.toLowerCase() === filter.subscriber!.toLowerCase());
  if (filter?.agent) subs = subs.filter((s) => s.agent.toLowerCase() === filter.agent!.toLowerCase());
  return { subscriptions: subs, isLoading: q.isLoading };
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
