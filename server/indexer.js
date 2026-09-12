import { ethers } from "ethers";
import fs from "node:fs";
import { provider, ADDR, USDC_DECIMALS } from "./chain.js";
import { storePath } from "./store-path.js";
import { createLogIndex } from "./eventIndex.js";

const ASSET_STORE = storePath("ASSET_STORE", "assets.json");
const AGENT_META_STORE = storePath("AGENT_META_STORE", "agent-meta.json");
function loadAssets() {
  try {
    return JSON.parse(fs.readFileSync(ASSET_STORE, "utf8"));
  } catch {
    return {};
  }
}
function loadAgentMeta() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_META_STORE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Server-side chain indexer.
 *
 * The browser was doing ~220 sequential eth_getLogs calls per load (56 chunks x
 * 4 contracts) against the public Arc RPC, which is fragile and rate-limited in
 * the browser even though the same reads are reliable server-side. So we index
 * here and serve the result as JSON at /api/index. The chain stays the single
 * source of truth (no database) - this is just a reliable read cache.
 *
 * Output shape matches the frontend's old in-browser indexer exactly:
 *   { tasks, agents, bids, activity }
 */

// Backfill start for each contract's persisted log index (~deploy block) —
// chunk size / range-cap handling now lives in chain.js's scanRange, shared
// with every other incremental index in the codebase.
const FROM_BLOCK = process.env.INDEX_FROM_BLOCK ? BigInt(process.env.INDEX_FROM_BLOCK) : null;

const EVENTS = {
  taskRegistry: [
    "event TaskSubmitted(bytes32 indexed taskId, address indexed requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)",
    "event TaskAssigned(bytes32 indexed taskId, address indexed agent, uint256 bidAmount)",
    "event TaskSettled(bytes32 indexed taskId, address indexed agent, uint256 amount)",
    "event TaskCancelled(bytes32 indexed taskId)",
    "event TaskTimedOut(bytes32 indexed taskId, address indexed agent)",
    "event TaskReopened(bytes32 indexed taskId)",
  ],
  agentRegistry: [
    "event AgentRegistered(address indexed wallet, bytes32 indexed agentId, uint256 stake, string name, string capabilities)",
    "event AgentDeactivated(address indexed wallet)",
    "event AgentRestaked(address indexed wallet, uint256 amount)",
    "event StakeWithdrawn(address indexed wallet, uint256 amount)",
    "event TaskAssignedToAgent(address indexed wallet, uint256 activeTasks)",
    "event ReputationUpdated(address indexed wallet, uint256 newRep)",
    "event AgentSlashed(address indexed wallet, uint256 penalty)",
  ],
  bidEngine: [
    "event BidPlaced(bytes32 indexed taskId, address indexed agent, uint256 amount, uint256 score, uint256 etaSeconds)",
    "event BidAwarded(bytes32 indexed taskId, address indexed winner, uint256 amount)",
  ],
  verifierBridge: [
    // Legacy V4 event retained so the index can render pre-GenLayer history.
    "event VerificationSubmitted(bytes32 indexed taskId, address indexed agent, bool passed, uint8 score, bytes32 deliverableHash)",
    "event VerificationSubmitted(bytes32 indexed taskId, address indexed agent, bool passed, uint8 score, bytes32 deliverableHash, bytes32 genLayerDecisionId)",
  ],
  agentBadges: [
    "event BadgeSet(address indexed agent, uint8 tier, string note)",
  ],
  disputeManager: [
    "event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed taskId, address indexed requester, address agent, uint256 bond, string reason)",
    "event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote)",
    "event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote, bytes32 genLayerDecisionId)",
  ],
};

const toUsdc = (raw) => Number(ethers.formatUnits(raw, USDC_DECIMALS));

// Recurring market tasks embed a tag in the on-chain description so the winning
// agent (and the UI) know the cadence. Pull it out and strip it from display.
function parseRecurring(desc) {
  const m = desc.match(/\[recurring deliveries=(\d+) schedule=([^\]]+)\]/i);
  if (!m) return { recurring: null, description: desc };
  return {
    recurring: { deliveries: Number(m[1]), schedule: m[2].trim() },
    description: desc.replace(m[0], "").replace(/^\s+/, ""),
  };
}
const refOf = (taskId) => taskId.slice(2, 10).toUpperCase();
function bytes32ToStr(b) {
  try {
    return ethers.toUtf8String(b).replace(/\0+$/, "") || b.slice(0, 10);
  } catch {
    return b.slice(0, 10);
  }
}

// Incremental, checkpointed replacement for a from-scratch full-history scan.
// Each contract gets its own persisted log index (see createLogIndex in
// eventIndex.js) so a steady-state refresh only fetches blocks since the last
// checkpoint (typically 0-2 chunks) instead of re-scanning the entire chain
// history (600+ chunks and growing every day) on every single cache rebuild —
// that full-rescan cost is what was starving the RPC's rate limit and leaving
// agents/bids stuck at 0 while tasks fluctuated. See docs/AUDIT_REPORT.md /
// the "agents/bids stuck at 0" investigation for the full diagnosis.
const logIndexes = new Map(); // contract key -> createLogIndex instance

function logIndexFor(key, address, eventSigs) {
  if (!address || address === "0x") return null;
  let idx = logIndexes.get(key);
  if (!idx) {
    idx = createLogIndex({
      name: `chain-${key}`,
      contract: new ethers.Contract(address, eventSigs, provider),
      filter: "*",
      store: storePath(`INDEX_${key.toUpperCase()}_STORE`, `chain-index-${key}.json`),
      fromBlock: FROM_BLOCK != null ? Number(FROM_BLOCK) : 0,
    });
    logIndexes.set(key, idx);
  }
  return idx;
}

async function getAllLogs(key, address, eventSigs) {
  const idx = logIndexFor(key, address, eventSigs);
  if (!idx) return [];
  return idx.catchUp();
}

// Persistent block->timestamp cache. A block's time never changes, so caching it
// across builds means each refresh only resolves blocks it hasn't seen — this is
// what keeps a task's "created" date correct even for older tasks (the previous
// last-400-blocks cap left older items stamped with Date.now()).
const blockTimeCache = new Map();
async function blockTimes(blocks) {
  const missing = Array.from(new Set(blocks)).filter((bn) => bn != null && !blockTimeCache.has(bn));
  // Resolve missing blocks in bounded-concurrency batches so a first run over a
  // wide window doesn't fire thousands of RPC calls at once.
  const BATCH = 40;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.all(
      missing.slice(i, i + BATCH).map(async (bn) => {
        try {
          const blk = await provider.getBlock(bn);
          if (blk) blockTimeCache.set(bn, Number(blk.timestamp) * 1000);
        } catch {
          /* leave uncached; a later refresh retries */
        }
      }),
    );
  }
  return blockTimeCache;
}

export async function buildIndex() {
  const [taskLogs, agentLogs, bidLogs, verifierLogs, badgeLogs, disputeLogs] = await Promise.all([
    getAllLogs("tasks", ADDR.taskRegistry, EVENTS.taskRegistry),
    getAllLogs("agents", ADDR.agentRegistry, EVENTS.agentRegistry),
    getAllLogs("bids", ADDR.bidEngine, EVENTS.bidEngine),
    getAllLogs("verifications", ADDR.verifierBridge, EVENTS.verifierBridge),
    getAllLogs("badges", ADDR.agentBadges, EVENTS.agentBadges),
    getAllLogs("disputes", ADDR.disputeManager, EVENTS.disputeManager),
  ]);

  const allBlocks = [...taskLogs, ...agentLogs, ...bidLogs, ...verifierLogs, ...disputeLogs].map((l) => l.blockNumber).filter((b) => b != null);
  const times = await blockTimes(allBlocks);
  const tsOf = (log) => times.get(log.blockNumber) ?? Date.now();

  /* Tasks */
  const tasks = new Map();
  for (const log of taskLogs) {
    const a = log.args;
    const id = a.taskId;
    if (log.name === "TaskSubmitted") {
      const { recurring, description } = parseRecurring(a.description || "");
      tasks.set(id, {
        taskId: id,
        ref: refOf(id),
        requester: a.requester,
        budgetUsdc: toUsdc(a.budgetUsdc),
        deadlineMs: Number(a.deadline) * 1000,
        minReputation: Number(a.minReputation),
        title: a.title || "Untitled task",
        description,
        rubric: a.rubric || "",
        taskType: a.taskType || "general",
        recurring, // { deliveries, schedule } when this is a recurring market task
        status: "OPEN",
        createdAtMs: tsOf(log),
        txHash: log.txHash,
      });
    } else if (log.name === "TaskAssigned") {
      const t = tasks.get(id);
      if (t) {
        t.status = "ASSIGNED";
        t.assignedAgent = a.agent;
        t.winningBid = toUsdc(a.bidAmount);
      }
    } else if (log.name === "TaskSettled") {
      const t = tasks.get(id);
      if (t) {
        t.status = "SETTLED";
        t.settledAtMs = tsOf(log);
      }
    } else if (log.name === "TaskCancelled") {
      const t = tasks.get(id);
      if (t) t.status = "CANCELLED";
    } else if (log.name === "TaskTimedOut") {
      // Agent missed the deadline; escrow refunds the requester. Treat as cancelled
      // so the task doesn't hang forever in ASSIGNED.
      const t = tasks.get(id);
      if (t && t.status !== "SETTLED") t.status = "CANCELLED";
    } else if (log.name === "TaskReopened") {
      const t = tasks.get(id);
      if (t) {
        t.status = "OPEN";
        t.assignedAgent = undefined;
        t.winningBid = undefined;
        t.reopened = true;
      }
    }
  }

  /* Onchain settlement attestations. A passing attestation is the on-chain proof
   * of completion, so force the task to SETTLED even if the TaskSettled event was
   * missed/lagged — otherwise a verified task is absent from the Settlement page. */
  for (const log of verifierLogs) {
    if (log.name !== "VerificationSubmitted") continue;
    const a = log.args;
    const t = tasks.get(a.taskId);
    if (!t) continue;
    t.attestation = { score: Number(a.score), passed: a.passed, deliverableHash: a.deliverableHash, genLayerDecisionId: a.genLayerDecisionId };
    if (a.passed && t.status !== "SETTLED" && t.status !== "CANCELLED") {
      t.status = "SETTLED";
      t.settledAtMs = t.settledAtMs ?? tsOf(log);
    }
  }

  /* Bids */
  const bids = [];
  const awarded = new Map();
  for (const log of bidLogs) {
    const a = log.args;
    if (log.name === "BidPlaced") {
      bids.push({
        taskId: a.taskId,
        agent: a.agent,
        amount: toUsdc(a.amount),
        score: Number(a.score),
        etaSeconds: Number(a.etaSeconds),
        won: false,
        atMs: tsOf(log),
      });
    } else if (log.name === "BidAwarded") {
      awarded.set(a.taskId, a.winner);
    }
  }
  for (const b of bids) {
    if (awarded.get(b.taskId)?.toLowerCase() === b.agent.toLowerCase()) b.won = true;
  }

  /* Agents */
  const agents = new Map();
  for (const log of agentLogs) {
    const a = log.args;
    const wallet = a.wallet?.toLowerCase();
    if (log.name === "AgentRegistered") {
      agents.set(wallet, {
        wallet: a.wallet,
        agentId: a.agentId,
        name: a.name || bytes32ToStr(a.agentId),
        capabilities: (a.capabilities || "").split(",").map((s) => s.trim()).filter(Boolean),
        stakeUsdc: toUsdc(a.stake),
        reputation: 100,
        tasksCompleted: 0,
        tasksFailed: 0,
        totalEarned: 0,
        online: true,
        slashed: false,
        tier: 0,
        badgeNote: "",
        createdAtMs: tsOf(log),
      });
    } else {
      const ag = agents.get(wallet);
      if (!ag) continue;
      if (log.name === "ReputationUpdated") ag.reputation = Number(a.newRep);
      else if (log.name === "AgentDeactivated") ag.online = false;
      else if (log.name === "StakeWithdrawn") {
        ag.online = false;
        ag.stakeUsdc = 0;
      } else if (log.name === "AgentRestaked") {
        ag.online = true;
        ag.stakeUsdc = toUsdc(a.amount);
      } else if (log.name === "AgentSlashed") {
        ag.slashed = true;
        ag.tasksFailed += 1;
      }
    }
  }

  /* Apply on-chain verification tiers (last write per agent wins) */
  for (const log of badgeLogs) {
    if (log.name !== "BadgeSet") continue;
    const ag = agents.get(log.args.agent?.toLowerCase());
    if (!ag) continue;
    ag.tier = Number(log.args.tier);
    ag.badgeNote = log.args.note || "";
  }

  /* Attach disputes (Phase C) to their tasks (latest per task), and count how
     many times each requester has disputed a task (for the 3-per-user cap). */
  const disputeById = new Map();
  const disputesByTask = new Map(); // taskId -> { [requesterLower]: count }
  for (const log of disputeLogs) {
    const a = log.args;
    if (log.name === "DisputeOpened") {
      disputeById.set(a.disputeId, {
        disputeId: a.disputeId,
        taskId: a.taskId,
        requester: a.requester,
        agent: a.agent,
        bond: toUsdc(a.bond),
        reason: a.reason || "",
        status: "OPEN",
        juryNote: "",
        openedAtMs: tsOf(log),
      });
      const byReq = disputesByTask.get(a.taskId) || {};
      const r = (a.requester || "").toLowerCase();
      byReq[r] = (byReq[r] || 0) + 1;
      disputesByTask.set(a.taskId, byReq);
    } else if (log.name === "DisputeResolved") {
      const dz = disputeById.get(a.disputeId);
      if (dz) {
        dz.status = a.upheld ? "UPHELD" : "REJECTED";
        dz.juryNote = a.juryNote || "";
        dz.genLayerDecisionId = a.genLayerDecisionId;
      }
    }
  }
  // Attach the latest dispute per task + the full list (for the dispute-detail page).
  for (const dz of disputeById.values()) {
    const t = tasks.get(dz.taskId);
    if (t) {
      t.dispute = dz; // latest wins (map insertion order)
      (t.disputes = t.disputes || []).push(dz);
    }
  }
  for (const [taskId, byReq] of disputesByTask) {
    const t = tasks.get(taskId);
    if (t) t.disputesByRequester = byReq;
  }

  /* Derive agent throughput + earnings from settled tasks */
  for (const t of tasks.values()) {
    if (t.status === "SETTLED" && t.assignedAgent) {
      const ag = agents.get(t.assignedAgent.toLowerCase());
      if (ag) {
        ag.tasksCompleted += 1;
        ag.totalEarned += t.winningBid ?? t.budgetUsdc;
      }
    }
  }

  /* Activity feed */
  const activity = [];
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
        atMs: t.settledAtMs ?? t.createdAtMs + 1,
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
      txHash: "0x",
      atMs: b.atMs,
    });
  }
  for (const ag of agents.values()) {
    activity.push({
      id: `agent-${ag.wallet}`,
      kind: "AGENT_REGISTERED",
      title: `Agent registered · ${ag.name}`,
      wallet: ag.wallet,
      txHash: "0x",
      atMs: ag.createdAtMs,
    });
  }
  activity.sort((x, y) => y.atMs - x.atMs);

  /* Attach off-chain cover/avatar images (keyed by taskId / agent wallet). */
  const assets = loadAssets();
  for (const t of tasks.values()) {
    const img = assets[t.taskId?.toLowerCase()];
    if (img) t.image = img;
  }

  /* Attach the latest reviewer feedback + attempt count (for re-bidding agents). */
  let deliverables = {};
  try {
    deliverables = JSON.parse(fs.readFileSync(process.env.DELIVERABLE_STORE || "./deliverables.json", "utf8"));
  } catch {
    /* none yet */
  }
  for (const t of tasks.values()) {
    const d = deliverables[t.taskId?.toLowerCase()];
    if (d?.lastReason) {
      t.feedback = d.lastReason;
      t.attempts = d.attempts || 0;
    }
  }
  const agentMeta = loadAgentMeta();
  for (const ag of agents.values()) {
    const img = assets[ag.wallet?.toLowerCase()];
    if (img) ag.image = img;
    const meta = agentMeta[ag.wallet?.toLowerCase()];
    if (meta?.endpoint) ag.endpoint = meta.endpoint;
  }

  return {
    tasks: Array.from(tasks.values()).sort((a, b) => b.createdAtMs - a.createdAtMs),
    agents: Array.from(agents.values()).sort((a, b) => b.reputation - a.reputation),
    bids,
    activity: activity.slice(0, 60),
    indexedAtMs: Date.now(),
  };
}

/* In-process cache so frequent polls don't hammer the rate-limited RPC.
 *
 * A full build scans the whole chain (FROM_BLOCK..head) and now takes ~80s — the
 * window grows every day while the head advances. The frontend polls every ~8s,
 * so a request-driven rebuild used to let a cold cache spawn a stampede of
 * overlapping 80s scans that tripped the RPC rate limit and never finished,
 * leaving /api/index hanging and the app blank. So:
 *   - single-flight: concurrent callers share ONE in-flight build,
 *   - stale-while-revalidate: requests are served from memory instantly and the
 *     refresh happens in the background — a request never blocks on a build
 *     (except the very first cold one before the boot warm-up lands),
 *   - boot warm-up + interval: keep the cache warm off the request path.
 * The chain stays the single source of truth; this is just a reliable cache. */
let cache = null;
let cacheAt = 0;
let building = null; // in-flight build promise (single-flight guard)
const TTL_MS = Number(process.env.INDEX_CACHE_MS || "30000");

// tasks/agents/bids are built from the full accumulated event log (see
// buildIndex above; each contract's log array is now served from a
// persisted, incrementally-updated createLogIndex — see getAllLogs above and
// eventIndex.js — rather than a from-scratch rescan every cycle) and events
// are never removed from chain history — a wallet stays in `agents` forever
// after registering (just marked offline/destaked on withdrawal), tasks are
// never deleted, and old bid events survive a reopen. So on a healthy chain
// these counts can only grow or hold steady, never shrink. A rebuild that
// comes back SMALLER than the current cache is therefore always a transient
// artifact (e.g. `provider.getBlockNumber()` failing mid-build), never a
// legitimate state change — reject it and keep serving the more complete
// snapshot. Kept as defense-in-depth after the incremental-index migration;
// originally added when a full-chain rescan on every cycle was starving the
// RPC's rate limit and leaving agents/bids permanently stuck at 0 while tasks
// fluctuated (the old guard only caught the all-zero case, not a partial one).
function isWorseThanCache(fresh) {
  if (!cache) return false;
  return (
    fresh.tasks.length < cache.tasks.length ||
    fresh.agents.length < cache.agents.length ||
    fresh.bids.length < cache.bids.length
  );
}

function refresh() {
  if (building) return building; // collapse concurrent builds into one
  building = (async () => {
    try {
      const fresh = await buildIndex();
      if (isWorseThanCache(fresh)) {
        console.warn(
          `[indexer] rejected a partial rebuild (tasks ${fresh.tasks.length}<${cache.tasks.length} or agents ${fresh.agents.length}<${cache.agents.length} or bids ${fresh.bids.length}<${cache.bids.length}) — keeping last good snapshot`,
        );
        cacheAt = Date.now(); // still mark "checked now" so getIndex doesn't force a synchronous rebuild
        return cache;
      }
      cache = fresh;
      cacheAt = Date.now();
      return cache;
    } finally {
      building = null;
    }
  })();
  return building;
}

export async function getIndex() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache; // fresh: serve instantly
  if (cache) {
    // Stale: serve the last good snapshot now, revalidate in the background.
    refresh().catch(() => {});
    return now - cacheAt > TTL_MS * 6 ? { ...cache, stale: true } : cache;
  }
  // Cold (no cache yet): build once, single-flighted so concurrent polls share it.
  return refresh();
}

// Warm the cache on boot and keep it warm on a timer, so /api/index serves from
// memory and never triggers a synchronous full-chain scan on the request path.
refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), TTL_MS).unref();
