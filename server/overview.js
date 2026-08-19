/**
 * Cross-network overview: every agent, every activity event, on every supported
 * network, from one place.
 *
 * WHY THIS IS NOT JUST `/api/index` TWICE. Each chain gets its own runtime service
 * (see networks.js `isActiveNetwork`) precisely so Arc and BOT Chain stay independent
 * rather than merely separate. That independence is right for indexing and settlement,
 * but it means no single URL could answer "how is the whole swarm doing?". This module
 * federates: it reads the networks THIS process indexes directly, and asks peer
 * runtimes over HTTP for the rest. A peer that is down or slow degrades one network's
 * row, not the page.
 *
 * WHAT IT REFUSES TO DO. It never sums money across chains. Arc settles in USDC and
 * BOT Chain in its own coin, so "total escrow" across both would add dollars to BOT and
 * produce a number that means nothing. Counts (agents, tasks, settlements) are
 * unit-free and safe to total; every currency figure stays beside its own ticker.
 */
import { activeNetworkIds, getNetwork, isDeployed, NETWORK_IDS } from "./networks.js";
import { getIndex } from "./indexer.js";

/** How long a federated peer read may take before that network is marked unreachable. */
const PEER_TIMEOUT_MS = Number(process.env.OVERVIEW_PEER_TIMEOUT_MS || 6000);
/** Cache window, so refreshing the page cannot stampede the peers or the indexer. */
const CACHE_MS = Number(process.env.OVERVIEW_CACHE_MS || 15000);

let cache = { at: 0, data: null, inFlight: null };

/**
 * Peer runtime base URLs.
 *
 * `PEER_RUNTIMES` is the explicit, host-agnostic form. On Railway the per-service URL
 * vars are picked up automatically so the deployment needs no extra configuration; a
 * runtime's own public domain is filtered out, because federating with yourself would
 * double-count every agent.
 */
export function peerUrls(env = process.env) {
  const explicit = (env.PEER_RUNTIMES || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const fromRailway = Object.keys(env)
    .filter((k) => /^RAILWAY_SERVICE_.*_URL$/.test(k))
    .map((k) => String(env[k] || "").trim())
    .filter(Boolean)
    .map((u) => (/^https?:\/\//.test(u) ? u : `https://${u}`))
    .map((u) => u.replace(/\/+$/, ""));

  const self = String(env.RAILWAY_PUBLIC_DOMAIN || "").trim().replace(/^https?:\/\//, "");
  const seen = new Set();
  return [...explicit, ...fromRailway].filter((u) => {
    const host = u.replace(/^https?:\/\//, "");
    if (self && host === self) return false; // never federate with ourselves
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
}

async function fetchJson(url, timeoutMs = PEER_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask each peer which networks it serves, so we only request an index from the runtime
 * that actually has one. Guessing instead would earn a 409 from `/api/index`, which is
 * the correct refusal but a wasted round trip.
 */
async function discoverPeers(urls) {
  const found = new Map(); // networkId -> base url
  await Promise.all(
    urls.map(async (base) => {
      try {
        const health = await fetchJson(`${base}/health`);
        for (const id of health?.serves ?? []) if (!found.has(id)) found.set(id, base);
      } catch {
        /* an unreachable peer simply contributes no networks */
      }
    }),
  );
  return found;
}

/** Per-network money, always paired with the ticker it is denominated in. */
function moneyOf(index, net) {
  const open = index.tasks.filter((t) => t.status === "OPEN" || t.status === "ASSIGNED");
  const settled = index.tasks.filter((t) => t.status === "SETTLED");
  return {
    symbol: net.asset.symbol,
    escrow: open.reduce((s, t) => s + (t.budgetUsdc || 0), 0),
    settledValue: settled.reduce((s, t) => s + (t.winningBid ?? t.budgetUsdc ?? 0), 0),
  };
}

function summarize(networkId, index, source) {
  const net = getNetwork(networkId);
  const agents = index.agents ?? [];
  const tasks = index.tasks ?? [];
  return {
    network: networkId,
    label: net.label,
    chainId: net.chainId,
    explorerUrl: net.explorerUrl,
    explorerName: net.explorerName,
    source, // "local" (this runtime indexes it) or "peer"
    agents: agents.length,
    online: agents.filter((a) => a.online).length,
    slashed: agents.filter((a) => a.slashed).length,
    withIdentity: agents.filter((a) => a.erc8004Id).length,
    tasks: tasks.length,
    openTasks: tasks.filter((t) => t.status === "OPEN").length,
    assignedTasks: tasks.filter((t) => t.status === "ASSIGNED").length,
    settledTasks: tasks.filter((t) => t.status === "SETTLED").length,
    bids: (index.bids ?? []).length,
    money: moneyOf({ tasks }, net),
    indexedAtMs: index.indexedAtMs ?? null,
  };
}

/**
 * Build the whole picture.
 *
 * Deliberately resilient: a network we cannot read becomes a row with an `error`, so
 * the page can say "BOT Chain unreachable" instead of quietly implying the swarm has
 * no agents there. That distinction is the entire value of an operator dashboard.
 */
export async function buildOverview({ env = process.env, now = Date.now } = {}) {
  const mine = activeNetworkIds();
  const peers = await discoverPeers(peerUrls(env));

  // Only networks whose contracts exist. This also keeps undeployed networks out of
  // the page entirely, rather than listing them as empty.
  const wanted = NETWORK_IDS.filter((id) => isDeployed(id) && (mine.includes(id) || peers.has(id)));

  const results = await Promise.all(
    wanted.map(async (id) => {
      try {
        const index = mine.includes(id)
          ? await getIndex(id)
          : await fetchJson(`${peers.get(id)}/api/index?network=${encodeURIComponent(id)}`);
        return { id, index, source: mine.includes(id) ? "local" : "peer", peer: peers.get(id) ?? null };
      } catch (e) {
        const net = getNetwork(id);
        return {
          id,
          error: e.message || String(e),
          source: mine.includes(id) ? "local" : "peer",
          peer: peers.get(id) ?? null,
          label: net.label,
          chainId: net.chainId,
        };
      }
    }),
  );

  const networks = [];
  const agents = [];
  const activity = [];

  for (const r of results) {
    if (r.error) {
      networks.push({
        network: r.id,
        label: r.label,
        chainId: r.chainId,
        source: r.source,
        error: r.error,
        agents: 0,
        online: 0,
        tasks: 0,
      });
      continue;
    }
    const net = getNetwork(r.id);
    networks.push(summarize(r.id, r.index, r.source));
    for (const a of r.index.agents ?? []) {
      agents.push({
        ...a,
        network: r.id,
        networkLabel: net.label,
        chainId: net.chainId,
        assetSymbol: net.asset.symbol,
        explorerUrl: net.explorerUrl,
      });
    }
    for (const ev of r.index.activity ?? []) {
      activity.push({ ...ev, network: r.id, networkLabel: net.label, assetSymbol: net.asset.symbol });
    }
  }

  // Reputation first: it is the only agent ranking the protocol itself enforces
  // (BidEngine's floor), so it is the honest default order for a swarm view.
  agents.sort((a, b) => b.reputation - a.reputation || b.tasksCompleted - a.tasksCompleted);
  activity.sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));

  const reachable = networks.filter((n) => !n.error);
  return {
    generatedAtMs: now(),
    serves: mine,
    peers: [...peers.entries()].map(([network, url]) => ({ network, url })),
    // Counts only. See the module note on why money is never summed across chains.
    totals: {
      networks: networks.length,
      networksReachable: reachable.length,
      agents: agents.length,
      online: agents.filter((a) => a.online).length,
      withIdentity: agents.filter((a) => a.erc8004Id).length,
      tasks: reachable.reduce((s, n) => s + n.tasks, 0),
      settledTasks: reachable.reduce((s, n) => s + n.settledTasks, 0),
      openTasks: reachable.reduce((s, n) => s + n.openTasks, 0),
      bids: reachable.reduce((s, n) => s + n.bids, 0),
    },
    networks,
    agents,
    activity: activity.slice(0, 120),
  };
}

/** Cached wrapper: many browser tabs must not multiply peer traffic. */
export async function getOverview(opts = {}) {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = buildOverview(opts)
    .then((data) => {
      cache = { at: Date.now(), data, inFlight: null };
      return data;
    })
    .catch((e) => {
      cache.inFlight = null;
      throw e;
    });
  return cache.inFlight;
}

/** Test seam. */
export function resetOverviewCache() {
  cache = { at: 0, data: null, inFlight: null };
}
