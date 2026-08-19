import { ethers } from "ethers";
import fs from "node:fs";
import { getChainCtx } from "./chain.js";
import { activeNetworkIds, DEFAULT_NETWORK, getNetwork, scopedKey } from "./networks.js";
import { storePath } from "./store-path.js";
import { createLogIndex } from "./eventIndex.js";
import { openIndexStore } from "./indexStore.js";
import { cachedAgentIds, erc8004Available } from "./erc8004.js";

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
 * Server-side chain indexer, one instance per network.
 *
 * The browser was doing ~220 sequential eth_getLogs calls per load (56 chunks x
 * 4 contracts) against the public RPC, which is fragile and rate-limited in the
 * browser even though the same reads are reliable server-side. So we index here
 * and serve the result at /api/index?network=<id>. The chain stays the single
 * source of truth (no database) - this is just a reliable read cache.
 *
 * MULTI-CHAIN: every cache, log index, checkpoint file and block-time map is
 * per-network. Nothing is shared between chains — a block number, a task id and
 * an agent wallet all mean different things on different networks, so mixing them
 * would corrupt both.
 *
 * Output shape matches the frontend's expectation exactly:
 *   { tasks, agents, bids, activity }
 */

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
  agentBadges: ["event BadgeSet(address indexed agent, uint8 tier, string note)"],
  // ERC-8004 identities are public by design: any application can read who holds which
  // agent id. Indexing the registry's own event is what makes that true here, rather
  // than only surfacing ids this particular runtime happened to mint.
  erc8004Identity: ["event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"],
  disputeManager: [
    "event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed taskId, address indexed requester, address agent, uint256 bond, string reason)",
    "event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote)",
  ],
};

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

/**
 * One indexer per network. Keeps its own incremental log indexes, block-time
 * cache and read cache.
 *
 * The log indexes are incremental and checkpointed (see createLogIndex in
 * eventIndex.js) so a steady-state refresh only fetches blocks since the last
 * checkpoint (typically 0-2 chunks) instead of re-scanning the entire chain
 * history on every cache rebuild — that full-rescan cost is what was starving the
 * RPC's rate limit and leaving agents/bids stuck at 0 while tasks fluctuated. It
 * matters even more on BOT Chain, where ~0.67s blocks add ~128k blocks a day.
 */
function createIndexer(networkId) {
  const ctx = getChainCtx(networkId);
  const net = getNetwork(networkId);
  // Durable store for this chain's logs and block times (see indexStore.js). One
  // file per chain id; null if SQLite is unavailable, in which case every index
  // keeps its JSON checkpoint.
  const db = openIndexStore(ctx.chainId);
  const toUsdc = (raw) => Number(ethers.formatUnits(raw, net.asset.decimals));

  const logIndexes = new Map(); // contract key -> createLogIndex instance

  /**
   * Checkpoint file for one contract's log index.
   *
   * Files are namespaced by chain id — two networks must never share a checkpoint
   * or each would skip the other's blocks. Arc is the exception: if a pre-
   * multi-chain checkpoint already exists under the old un-namespaced name, keep
   * using it. Renaming it would throw away a warm checkpoint and force one full
   * from-deploy-block re-scan on the live deployment, which is exactly the
   * RPC-starving rebuild the incremental index was built to avoid.
   */
  function checkpointPath(key) {
    const envVar = `INDEX_${key.toUpperCase()}_STORE_${ctx.chainId}`;
    if (process.env[envVar]) return process.env[envVar];
    if (networkId === DEFAULT_NETWORK) {
      const legacy = storePath(`INDEX_${key.toUpperCase()}_STORE`, `chain-index-${key}.json`);
      try {
        if (fs.existsSync(legacy)) return legacy;
      } catch {
        /* fall through to the namespaced path */
      }
    }
    return storePath(envVar, `chain-index-${ctx.chainId}-${key}.json`);
  }

  function logIndexFor(key, address, eventSigs) {
    if (!address || address === "0x") return null;
    let idx = logIndexes.get(key);
    if (!idx) {
      idx = createLogIndex({
        name: `chain-${networkId}-${key}`,
        contract: new ethers.Contract(address, eventSigs, ctx.provider),
        filter: "*",
        store: checkpointPath(key),
        fromBlock: ctx.indexFromBlock != null ? Number(ctx.indexFromBlock) : 0,
        // Each network scans with its OWN provider and chunked scanner.
        scanRange: ctx.scanRange,
        provider: ctx.provider,
        db,
        key,
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

  // Block->timestamp cache, now DURABLE. A block's timestamp never changes, so
  // this is the most re-fetchable data in the system — and it used to be a plain
  // in-memory Map despite the comment here claiming otherwise, so every restart
  // re-resolved every block a task touched via eth_getBlock. On Arc that is
  // thousands of calls per boot and was the main source of the RPC rate-limit
  // errors. Backed by the block_times table now; loaded once, written through.
  // Per-network: block 100 on Arc and block 100 on BOT Chain are unrelated, which
  // is why the store is per chain id.
  let blockTimeCache = null;
  function blockCache() {
    if (blockTimeCache) return blockTimeCache;
    blockTimeCache = new Map();
    if (db) {
      try {
        blockTimeCache = db.loadBlockTimes();
        if (blockTimeCache.size) console.log(`[index:${networkId}] loaded ${blockTimeCache.size} cached block times`);
      } catch (e) {
        console.error(`[index:${networkId}] block-time load failed: ${e.message}`);
        blockTimeCache = new Map();
      }
    }
    return blockTimeCache;
  }
  async function blockTimes(blocks) {
    const cache = blockCache();
    const fresh = [];
    const missing = Array.from(new Set(blocks)).filter((bn) => bn != null && !cache.has(bn));
    // Resolve missing blocks in bounded-concurrency batches so a first run over a
    // wide window doesn't fire thousands of RPC calls at once.
    const BATCH = 40;
    for (let i = 0; i < missing.length; i += BATCH) {
      await Promise.all(
        missing.slice(i, i + BATCH).map(async (bn) => {
          try {
            const blk = await ctx.provider.getBlock(bn);
            if (blk) {
              const ms = Number(blk.timestamp) * 1000;
              cache.set(bn, ms);
              fresh.push([bn, ms]);
            }
          } catch {
            /* leave uncached; a later refresh retries */
          }
        }),
      );
    }
    // Write through, so the next boot doesn't pay for these blocks again.
    if (db && fresh.length) {
      try {
        db.saveBlockTimes(fresh);
      } catch (e) {
        console.error(`[index:${networkId}] block-time persist failed: ${e.message}`);
      }
    }
    return cache;
  }

  async function buildIndex() {
    const [taskLogs, agentLogs, bidLogs, verifierLogs, badgeLogs, disputeLogs, identityLogs] = await Promise.all([
      getAllLogs("tasks", ctx.ADDR.taskRegistry, EVENTS.taskRegistry),
      getAllLogs("agents", ctx.ADDR.agentRegistry, EVENTS.agentRegistry),
      getAllLogs("bids", ctx.ADDR.bidEngine, EVENTS.bidEngine),
      getAllLogs("verifications", ctx.ADDR.verifierBridge, EVENTS.verifierBridge),
      getAllLogs("badges", ctx.ADDR.agentBadges, EVENTS.agentBadges),
      getAllLogs("disputes", ctx.ADDR.disputeManager, EVENTS.disputeManager),
      getAllLogs("erc8004", ctx.ADDR.erc8004Identity, EVENTS.erc8004Identity),
    ]);

    const allBlocks = [...taskLogs, ...agentLogs, ...bidLogs, ...verifierLogs, ...disputeLogs]
      .map((l) => l.blockNumber)
      .filter((b) => b != null);
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
          // Which chain this task lives on. The frontend never mixes networks,
          // but anything that stores or forwards a task must carry its chain.
          network: networkId,
          chainId: ctx.chainId,
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
        // Agent missed the deadline; escrow refunds the requester. Treat as
        // cancelled so the task doesn't hang forever in ASSIGNED.
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
          network: networkId,
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
          network: networkId,
          chainId: ctx.chainId,
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
          network: networkId,
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

    /* Attach off-chain cover/avatar images. Stores are keyed `chainId:id` so two
     * networks can't collide; legacy un-prefixed keys (written before multi-chain
     * support) are still honoured for Arc so existing data isn't orphaned. */
    const assets = loadAssets();
    const assetFor = (id) => {
      if (!id) return undefined;
      const k = String(id).toLowerCase();
      return assets[scopedKey(networkId, k)] ?? (networkId === DEFAULT_NETWORK ? assets[k] : undefined);
    };
    for (const t of tasks.values()) {
      const img = assetFor(t.taskId);
      if (img) t.image = img;
    }

    /* Attach the latest reviewer feedback + attempt count (for re-bidding agents). */
    let deliverables = {};
    try {
      deliverables = JSON.parse(fs.readFileSync(storePath("DELIVERABLE_STORE", "deliverables.json"), "utf8"));
    } catch {
      /* none yet */
    }
    for (const t of tasks.values()) {
      const k = String(t.taskId).toLowerCase();
      const d = deliverables[scopedKey(networkId, k)] ?? (networkId === DEFAULT_NETWORK ? deliverables[k] : undefined);
      if (d?.lastReason) {
        t.feedback = d.lastReason;
        t.attempts = d.attempts || 0;
      }
    }
    const agentMeta = loadAgentMeta();
    // ERC-8004 identities, from the runtime's own id cache. Read from the cache only,
    // never by scanning: this runs on every index build, and a chain lookup per agent
    // would put the whole page behind the rate-limited RPC. An agent minted by this
    // runtime is in the cache; anything else simply has no id to show, which is
    // honest rather than misleading.
    // Indexed first, mint cache second. The index is the authoritative and complete
    // view (it sees every Registered event, whoever sent it, including an agent's own
    // ERC-4337 account minting for itself); the cache still covers anything this
    // runtime minted whose event falls outside the indexed range.
    const identities = erc8004Available(ctx) ? { ...cachedAgentIds(ctx) } : {};
    for (const log of identityLogs) {
      const owner = String(log.args?.owner ?? "").toLowerCase();
      const agentId = log.args?.agentId;
      if (owner && agentId != null) identities[owner] = String(agentId);
    }
    for (const ag of agents.values()) {
      const img = assetFor(ag.wallet);
      if (img) ag.image = img;
      const k = String(ag.wallet).toLowerCase();
      const meta = agentMeta[scopedKey(networkId, k)] ?? (networkId === DEFAULT_NETWORK ? agentMeta[k] : undefined);
      if (meta?.endpoint) ag.endpoint = meta.endpoint;
      const id = identities[k];
      if (id != null) {
        ag.erc8004Id = String(id);
        ag.erc8004Registry = ctx.ADDR.erc8004Identity;
      }
    }

    return {
      network: networkId,
      chainId: ctx.chainId,
      tasks: Array.from(tasks.values()).sort((a, b) => b.createdAtMs - a.createdAtMs),
      agents: Array.from(agents.values()).sort((a, b) => b.reputation - a.reputation),
      bids,
      activity: activity.slice(0, 60),
      indexedAtMs: Date.now(),
    };
  }

  /* In-process cache so frequent polls don't hammer the rate-limited RPC.
   *
   * A cold build scans the whole configured window, so:
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

  // tasks/agents/bids are built from the full accumulated event log and events are
  // never removed from chain history — a wallet stays in `agents` forever after
  // registering (just marked offline/destaked on withdrawal), tasks are never
  // deleted, and old bid events survive a reopen. So on a healthy chain these
  // counts can only grow or hold steady, never shrink. A rebuild that comes back
  // SMALLER than the current cache is therefore always a transient artifact (e.g.
  // `provider.getBlockNumber()` failing mid-build), never a legitimate state
  // change — reject it and keep serving the more complete snapshot.
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
            `[indexer:${networkId}] rejected a partial rebuild (tasks ${fresh.tasks.length}<${cache.tasks.length} or agents ${fresh.agents.length}<${cache.agents.length} or bids ${fresh.bids.length}<${cache.bids.length}) — keeping last good snapshot`,
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

  async function getIndex() {
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

  return { networkId, buildIndex, getIndex, refresh, TTL_MS };
}

/* ── Registry of per-network indexers ─────────────────────────────────────────*/

const indexers = new Map();

function indexerFor(networkId) {
  const id = networkId || DEFAULT_NETWORK;
  let ix = indexers.get(id);
  if (!ix) {
    ix = createIndexer(id);
    indexers.set(id, ix);
  }
  return ix;
}

/** The index for one network. Defaults to Arc, matching the old signature. */
export async function getIndex(networkId = DEFAULT_NETWORK) {
  return indexerFor(networkId).getIndex();
}

/** Direct (uncached) build — used by tooling/tests. */
export async function buildIndex(networkId = DEFAULT_NETWORK) {
  return indexerFor(networkId).buildIndex();
}

// Warm the cache on boot and keep it warm on a timer for every network the
// runtime is configured to serve, so /api/index serves from memory and never
// triggers a synchronous full-chain scan on the request path.
for (const id of activeNetworkIds()) {
  const ix = indexerFor(id);
  ix.refresh().catch(() => {});
  setInterval(() => ix.refresh().catch(() => {}), ix.TTL_MS).unref();
}
