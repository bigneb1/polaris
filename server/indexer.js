import { ethers } from "ethers";
import fs from "node:fs";
import { provider, ADDR, USDC_DECIMALS } from "./chain.js";

const ASSET_STORE = process.env.ASSET_STORE || "./assets.json";
const AGENT_META_STORE = process.env.AGENT_META_STORE || "./agent-meta.json";
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

// Pin the scan start to keep RPC usage tiny: the public Arc RPC has a hard daily
// request cap. A fixed FROM_BLOCK (set to ~deploy block) means we scan a small,
// bounded window instead of 500k blocks (which is ~56 chunks x 4 contracts per
// build and exhausts the quota fast).
const FROM_BLOCK = process.env.INDEX_FROM_BLOCK ? BigInt(process.env.INDEX_FROM_BLOCK) : null;
const LOOKBACK = BigInt(process.env.INDEX_LOOKBACK_BLOCKS || "150000");
const RAW_CHUNK = BigInt(process.env.INDEX_CHUNK_BLOCKS || "9000");
// Arc caps eth_getLogs at a 10,000-block range; stay strictly under it.
const CHUNK = RAW_CHUNK > 9000n || RAW_CHUNK < 1n ? 9000n : RAW_CHUNK;

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
    "event VerificationSubmitted(bytes32 indexed taskId, address indexed agent, bool passed, uint8 score, bytes32 deliverableHash)",
  ],
  agentBadges: [
    "event BadgeSet(address indexed agent, uint8 tier, string note)",
  ],
  disputeManager: [
    "event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed taskId, address indexed requester, address agent, uint256 bond, string reason)",
    "event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote)",
  ],
};

const toUsdc = (raw) => Number(ethers.formatUnits(raw, USDC_DECIMALS));
const refOf = (taskId) => taskId.slice(2, 10).toUpperCase();
function bytes32ToStr(b) {
  try {
    return ethers.toUtf8String(b).replace(/\0+$/, "") || b.slice(0, 10);
  } catch {
    return b.slice(0, 10);
  }
}

async function getAllLogs(address, eventSigs) {
  if (!address || address === "0x") return [];
  const iface = new ethers.Interface(eventSigs);
  const c = new ethers.Contract(address, eventSigs, provider);
  const head = await provider.getBlockNumber();
  const start = FROM_BLOCK ?? (head > Number(LOOKBACK) ? BigInt(head) - LOOKBACK : 0n);
  const out = [];
  for (let from = start; from <= BigInt(head); from += CHUNK) {
    const to = from + CHUNK - 1n > BigInt(head) ? BigInt(head) : from + CHUNK - 1n;
    try {
      const logs = await c.queryFilter("*", Number(from), Number(to));
      for (const lg of logs) {
        try {
          const parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
          if (parsed) out.push({ name: parsed.name, args: parsed.args, blockNumber: lg.blockNumber, txHash: lg.transactionHash });
        } catch {
          /* not one of our events */
        }
      }
    } catch {
      /* skip a bad chunk; the next refresh retries */
    }
  }
  return out;
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
    getAllLogs(ADDR.taskRegistry, EVENTS.taskRegistry),
    getAllLogs(ADDR.agentRegistry, EVENTS.agentRegistry),
    getAllLogs(ADDR.bidEngine, EVENTS.bidEngine),
    getAllLogs(ADDR.verifierBridge, EVENTS.verifierBridge),
    getAllLogs(ADDR.agentBadges, EVENTS.agentBadges),
    getAllLogs(ADDR.disputeManager, EVENTS.disputeManager),
  ]);

  const allBlocks = [...taskLogs, ...agentLogs, ...bidLogs, ...verifierLogs].map((l) => l.blockNumber).filter((b) => b != null);
  const times = await blockTimes(allBlocks);
  const tsOf = (log) => times.get(log.blockNumber) ?? Date.now();

  /* Tasks */
  const tasks = new Map();
  for (const log of taskLogs) {
    const a = log.args;
    const id = a.taskId;
    if (log.name === "TaskSubmitted") {
      tasks.set(id, {
        taskId: id,
        ref: refOf(id),
        requester: a.requester,
        budgetUsdc: toUsdc(a.budgetUsdc),
        deadlineMs: Number(a.deadline) * 1000,
        minReputation: Number(a.minReputation),
        title: a.title || "Untitled task",
        description: a.description || "",
        rubric: a.rubric || "",
        taskType: a.taskType || "general",
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
    t.attestation = { score: Number(a.score), passed: a.passed, deliverableHash: a.deliverableHash };
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

  /* Attach disputes (Phase C) to their tasks (latest per task) */
  const disputeById = new Map();
  for (const log of disputeLogs) {
    const a = log.args;
    if (log.name === "DisputeOpened") {
      disputeById.set(a.disputeId, {
        disputeId: a.disputeId,
        taskId: a.taskId,
        bond: toUsdc(a.bond),
        reason: a.reason || "",
        status: "OPEN",
        juryNote: "",
      });
    } else if (log.name === "DisputeResolved") {
      const dz = disputeById.get(a.disputeId);
      if (dz) {
        dz.status = a.upheld ? "UPHELD" : "REJECTED";
        dz.juryNote = a.juryNote || "";
      }
    }
  }
  for (const dz of disputeById.values()) {
    const t = tasks.get(dz.taskId);
    if (t) t.dispute = dz;
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

function refresh() {
  if (building) return building; // collapse concurrent builds into one
  building = (async () => {
    try {
      const fresh = await buildIndex();
      // Don't overwrite a populated snapshot with an empty one (transient RPC
      // fail that returned zero logs rather than throwing).
      if (cache && fresh.tasks.length === 0 && fresh.agents.length === 0 && cache.tasks.length > 0) {
        cacheAt = Date.now();
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
