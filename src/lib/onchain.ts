import { useQuery } from "@tanstack/react-query";
import { useNetwork } from "../context/NetworkProvider";
import { getNetwork, isNetworkReady, type NetworkId } from "./networks";
import type { Task, Agent, Bid, ActivityEvent, MarketStats, TaskStatus, Subscription, RecurringPlan } from "./types";

/* ── Backend-served chain index ──────────────────────────────────────────────
 * The browser used to make ~220 sequential eth_getLogs calls against the public
 * Arc RPC per load (56 chunks x 4 contracts), which is fragile and rate-limited
 * in the browser and left the UI empty. The Railway runtime now indexes each
 * chain reliably and serves the result at /api/index?network=<id>; the chain
 * remains the single source of truth (no database). We just fetch that JSON here.
 *
 * MULTI-CHAIN: every query key is scoped by network id, so switching networks can
 * never render the other chain's cached agents/tasks/bids while the new request
 * is in flight.
 */
const REFETCH_MS = 8000;

/** The runtime that serves this network — Arc and BOT Chain run separate
 *  services, so the host is part of the network config, not a global. */
function apiUrl(network: NetworkId, path: string): string {
  const base = getNetwork(network).apiBaseUrl.replace(/\/$/, "");
  return `${base}${path}?network=${encodeURIComponent(network)}`;
}

type IndexResult = { tasks: Task[]; agents: Agent[]; bids: Bid[]; activity: ActivityEvent[] };

async function fetchIndex(network: NetworkId): Promise<IndexResult> {
  const r = await fetch(apiUrl(network, "/api/index"));
  if (!r.ok) throw new Error(`index request failed (${r.status})`);
  const d = (await r.json()) as Partial<IndexResult>;
  return { tasks: d.tasks ?? [], agents: d.agents ?? [], bids: d.bids ?? [], activity: d.activity ?? [] };
}

/* ── Hooks ───────────────────────────────────────────────────────────────────*/

function useIndex() {
  const { networkId } = useNetwork();
  return useQuery({
    queryKey: ["polaris-index", networkId],
    refetchInterval: REFETCH_MS,
    enabled: isNetworkReady(networkId),
    queryFn: () => fetchIndex(networkId),
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
  return { task, bids, isLoading: q.isLoading, error: q.error };
}

export function useAgents() {
  const q = useIndex();
  return { agents: q.data?.agents ?? [], isLoading: q.isLoading, error: q.error };
}

/** A single agent + every task it has been assigned (current + completed). */
export function useAgent(wallet?: string) {
  const q = useIndex();
  const w = wallet?.toLowerCase();
  const agent = q.data?.agents.find((a) => a.wallet.toLowerCase() === w);
  const tasks = (q.data?.tasks ?? [])
    .filter((t) => t.assignedAgent?.toLowerCase() === w)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { agent, tasks, isLoading: q.isLoading, error: q.error };
}

export function useActivity() {
  const q = useIndex();
  return { activity: q.data?.activity ?? [], isLoading: q.isLoading, error: q.error };
}

/* ── Subscriptions (recurring tasks) — served separately from the chain index ── */
async function fetchSubscriptions(network: NetworkId): Promise<Subscription[]> {
  const r = await fetch(apiUrl(network, "/api/subscriptions"));
  if (!r.ok) throw new Error(`subscriptions request failed (${r.status})`);
  const d = (await r.json()) as { subscriptions?: Subscription[] };
  return d.subscriptions ?? [];
}

/** All subscriptions, optionally filtered to a subscriber or an agent wallet. */
export function useSubscriptions(filter?: { subscriber?: string; agent?: string }) {
  const { networkId } = useNetwork();
  const q = useQuery({
    queryKey: ["polaris-subscriptions", networkId],
    refetchInterval: REFETCH_MS,
    enabled: isNetworkReady(networkId),
    queryFn: () => fetchSubscriptions(networkId),
  });
  let subs = q.data ?? [];
  if (filter?.subscriber) subs = subs.filter((s) => s.subscriber.toLowerCase() === filter.subscriber!.toLowerCase());
  if (filter?.agent) subs = subs.filter((s) => s.agent.toLowerCase() === filter.agent!.toLowerCase());
  return { subscriptions: subs, isLoading: q.isLoading, error: q.error };
}

async function fetchPlans(network: NetworkId): Promise<RecurringPlan[]> {
  const r = await fetch(apiUrl(network, "/api/recurring-plans"));
  if (!r.ok) throw new Error(`plans request failed (${r.status})`);
  return ((await r.json()) as { plans?: RecurringPlan[] }).plans ?? [];
}

/** Recurring-market plans (auctioned recurring tasks), optionally filtered by requester. */
export function useRecurringPlans(filter?: { requester?: string }) {
  const { networkId } = useNetwork();
  const q = useQuery({
    queryKey: ["polaris-recurring-plans", networkId],
    refetchInterval: REFETCH_MS,
    enabled: isNetworkReady(networkId),
    queryFn: () => fetchPlans(networkId),
  });
  let plans = q.data ?? [];
  if (filter?.requester) plans = plans.filter((p) => p.requester.toLowerCase() === filter.requester!.toLowerCase());
  return { plans, isLoading: q.isLoading, error: q.error };
}

export function useMarketStats(): { stats: MarketStats; isLoading: boolean; error: Error | null } {
  const q = useIndex();
  const tasks = q.data?.tasks ?? [];
  const agents = q.data?.agents ?? [];
  // Anchored to when the index was last fetched rather than to `Date.now()`, so the
  // 24-hour window is a pure function of the data and only moves when the data does.
  // Reading the clock during render makes the same props produce different output.
  const dayAgo = (q.dataUpdatedAt || 0) - 86400_000;
  // Everything that is not yet settled or cancelled counts as open work.
  const openStatuses: TaskStatus[] = ["OPEN", "ASSIGNED"];
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
  return { stats, isLoading: q.isLoading, error: q.error as Error | null };
}
