import { ethers } from "ethers";
import "dotenv/config";
import { DEFAULT_NETWORK, getNetwork, isNetworkId, NETWORK_IDS } from "./networks.js";
import { withRpcRetry } from "./rpcRetry.js";

/**
 * Shared chain layer for the backend verifier and the agent runtime.
 *
 * MULTI-CHAIN: everything chain-specific lives in a per-network context built by
 * `getChainCtx(networkId)` — its own failover provider, its own contract
 * addresses, its own task-metadata cache, its own getLogs chunk size. One runtime
 * can therefore serve Arc and BOT Chain at once without either seeing the other's
 * state.
 *
 * The original module-level exports (`provider`, `ADDR`, `CHAIN_ID`,
 * `readTaskMeta`, …) are kept as aliases bound to Arc, so every existing import
 * keeps working exactly as before while callers migrate to an explicit context.
 *
 * Reads task metadata straight from on-chain events (chain is source of truth),
 * and exposes minimal ABIs for the contract calls each process makes.
 */

export const USDC_DECIMALS = 6;

/* ── Providers ──────────────────────────────────────────────────────────────── */

/**
 * Build a failover provider for a network: try the configured primary
 * endpoint(s) first, then fall back to the chain's public RPC. quorum:1 means the
 * first endpoint to answer wins (failover, not consensus), and a stalled endpoint
 * is skipped to the next.
 *
 * A static network avoids a per-provider eth_chainId detection round-trip (which
 * itself fails under rate limits — the "failed to detect network" startup crash)
 * and saves RPC budget.
 */
/**
 * A flapping endpoint can retry hundreds of times a minute, and a log line per
 * retry buries everything else — which is exactly what made the 503 outage hard to
 * read in the first place. One line per method per minute is enough to see that an
 * endpoint is sick without losing the swarm's own output.
 */
const retryLogAt = new Map();
function logRetryThrottled(netId, url, { method, attempt, error }) {
  const key = `${netId}:${method}`;
  const now = Date.now();
  if (now - (retryLogAt.get(key) ?? 0) < 60_000) return;
  retryLogAt.set(key, now);
  console.warn(
    `[chain:${netId}] ${method} failed on ${url} (attempt ${attempt}): ${error.shortMessage || error.message} — retrying`,
  );
}

function buildProvider(net) {
  const network = ethers.Network.from({ chainId: net.chainId, name: net.id });
  const primaries = String(net.rpcUrl || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const urls = [...new Set([...primaries, net.publicRpcUrl].filter(Boolean))];
  const stall = Number(process.env.RPC_STALL_MS || 3000);
  // Retry wraps each ENDPOINT, not the failover group: a 503 from one URL is
  // repeated against that URL briefly before the FallbackProvider gives up on it,
  // and on a single-URL network (both BOT chains) it is the only resilience there
  // is. Without it a flapping RPC reached the swarm tick verbatim and stalled it.
  const subs = urls.map((url, i) => ({
    provider: withRpcRetry(new ethers.JsonRpcProvider(url, network, { staticNetwork: network }), {
      onRetry: (info) => logRetryThrottled(net.id, url, info),
    }),
    priority: i + 1, // lower number is tried first
    weight: 1,
    stallTimeout: stall,
  }));
  if (subs.length === 0) throw new Error(`No RPC URL configured for ${net.id}`);
  // A single URL needs no FallbackProvider overhead.
  if (subs.length === 1) return subs[0].provider;
  console.log(`[chain:${net.id}] RPC failover: ${urls.join(" → ")}`);
  return new ethers.FallbackProvider(subs, network, { quorum: 1 });
}

/* ── ABIs (chain-agnostic — the same contracts are deployed on every network) ── */

export const ABI = {
  erc20: [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ],
  taskRegistry: [
    "function tasks(bytes32) view returns (bytes32 taskId, address requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt, uint256 winningBid)",
    "function reopenTask(bytes32 taskId)",
    // Permissionless deadline enforcement: refunds the requester and slashes the agent on an
    // assigned task that blew its deadline. It was missing from this ABI, so the runtime had
    // no way to call the one escape hatch the contracts provide, and a stalled task stayed
    // ASSIGNED for good with the budget locked in escrow.
    "function slashOnTimeout(bytes32 taskId)",
    "event TaskTimedOut(bytes32 indexed taskId, address indexed agent)",
    "event TaskSubmitted(bytes32 indexed taskId, address indexed requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)",
    "event TaskAssigned(bytes32 indexed taskId, address indexed agent, uint256 bidAmount)",
    "event TaskReopened(bytes32 indexed taskId)",
  ],
  agentRegistry: [
    "function register(bytes32,uint256,string,string)",
    "function restake(uint256)",
    "function isOnline(address) view returns (bool)",
    "function getReputation(address) view returns (uint256)",
    "function agents(address) view returns (address wallet, bytes32 agentId, uint256 stakedUsdc, uint256 reputation, uint256 tasksCompleted, uint256 tasksFailed, uint256 activeTasks, bool online, bool registered)",
  ],
  bidEngine: [
    "function placeBid(bytes32,uint256,uint256)",
    "function awardBid(bytes32)",
    "function bidCount(bytes32) view returns (uint256)",
    "function auctionClosed(bytes32) view returns (bool)",
    "event BidAwarded(bytes32 indexed taskId, address indexed winner, uint256 amount)",
  ],
  verifierBridge: [
    "function submitVerification(bytes32,address,address,bool,uint8,bytes32,bytes)",
    "function processed(bytes32) view returns (bool)",
  ],
  subscriptionManager: [
    "function recordDelivery(bytes32 subId, uint32 index, bytes32 deliverableHash, uint8 score, bytes signature)",
    "function getSubscription(bytes32) view returns (address subscriber, address agent, uint256 perDeliveryUsdc, uint32 totalDeliveries, uint32 deliveriesDone, uint256 escrowed, bool active)",
    "event SubscriptionCreated(bytes32 indexed subId, address indexed subscriber, address indexed agent, uint256 perDeliveryUsdc, uint32 totalDeliveries, string title, string brief, string rubric, string taskType, string schedule)",
    "event DeliveryReleased(bytes32 indexed subId, address indexed agent, uint32 index, uint256 amount, uint8 score, bytes32 deliverableHash)",
    "event SubscriptionCancelled(bytes32 indexed subId, uint256 refund)",
  ],
  disputeManager: [
    "function resolveDispute(bytes32 disputeId, bool upheld, string juryNote, bytes signature)",
    "function getDispute(bytes32) view returns (address requester, address agent, bytes32 taskId, uint256 bond, uint8 status)",
    "event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed taskId, address indexed requester, address agent, uint256 bond, string reason)",
    "event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote)",
  ],
  recurringMarket: [
    "function bid(bytes32 planId, uint256 price, uint256 etaSeconds)",
    "function award(bytes32 planId)",
    "function recordDelivery(bytes32 planId, uint32 index, bytes32 deliverableHash, uint8 score, bytes signature)",
    "function getPlan(bytes32) view returns (address requester, address agent, uint256 perDelivery, uint256 price, uint32 total, uint32 done, uint256 escrowed, uint256 minReputation, uint8 status)",
    "function bidCount(bytes32) view returns (uint256)",
    "function bidsOf(bytes32, uint256) view returns (address agent, uint256 price, uint256 score)",
    "event PlanCreated(bytes32 indexed planId, address indexed requester, uint256 perDelivery, uint32 total, uint256 minReputation, string title, string brief, string rubric, string taskType, string schedule)",
    "event PlanBid(bytes32 indexed planId, address indexed agent, uint256 price, uint256 score)",
    "event PlanAwarded(bytes32 indexed planId, address indexed agent, uint256 price)",
    "event DeliveryReleased(bytes32 indexed planId, address indexed agent, uint32 index, uint256 amount, uint8 score, bytes32 deliverableHash)",
    "event PlanCancelled(bytes32 indexed planId, uint256 refund)",
  ],
};

/* ── getLogs helpers (bound to a context's provider + chunk size) ──────────── */

/** One bounded getLogs call, retried on transient errors. Throws with
 *  `.rateLimited = true` on a daily-quota / 429 rejection (don't retry those —
 *  it only burns more of an exhausted budget). */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(e) {
  const msg = e.shortMessage || e.message || "";
  return e.error?.code === -32003 || e.error?.code === -32005 || /limit|quota|429/i.test(msg);
}

/**
 * One chunked getLogs call, with backoff.
 *
 * A rate limit used to be treated as immediately fatal here: it threw on the first
 * -32005 without waiting. Because `scanRange` stops (never skips) on any failure,
 * that meant a cold index on a public RPC could never advance past the first
 * throttled chunk — every tick hit the limit at roughly the same block and gave up,
 * which is why Arc's production index sat at 4 tasks against 270 on chain.
 *
 * A rate limit is transient by definition, so it gets the longest backoff of any
 * error class rather than the shortest. Only when the RPC keeps refusing across the
 * whole ladder is the chunk reported as rate-limited, and the caller then keeps its
 * checkpoint and retries on the next tick.
 */
/**
 * How long to wait after each successive rate-limit refusal. Overridable so tests can
 * exercise the ladder without sleeping through it, and so an operator on a stricter
 * endpoint can lengthen it without a deploy.
 */
export function rateLimitBackoffMs() {
  const raw = process.env.INDEX_RATE_LIMIT_BACKOFF_MS;
  if (!raw) return [1000, 2500, 6000, 12000];
  const segments = raw.split(",").map((n) => n.trim());
  // A rung of 0 is legitimate (retry immediately), but a blank segment is not a
  // number anyone typed, and `Number("")` is 0, so it has to be rejected explicitly
  // or "1000,," would silently mean "wait, then hammer twice".
  const parsed = segments.filter((n) => n !== "").map(Number);
  const usable = parsed.length === segments.filter((n) => n !== "").length
    && parsed.every((n) => Number.isFinite(n) && n >= 0);
  return usable && parsed.length ? parsed : [1000, 2500, 6000, 12000];
}

export async function queryOneChunk(contract, filter, from, to) {
  const RATE_LIMIT_BACKOFF_MS = rateLimitBackoffMs();
  let rateLimitAttempt = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await contract.queryFilter(filter, from, to);
    } catch (e) {
      if (isRateLimit(e)) {
        const wait = RATE_LIMIT_BACKOFF_MS[rateLimitAttempt++];
        if (wait == null) {
          e.rateLimited = true;
          throw e;
        }
        await sleep(wait);
        continue;
      }
      if (attempt === 5) throw e;
      await sleep(250 * (attempt + 1));
    }
  }
  // The loop only exits via return or throw; this satisfies static analysis.
  throw new Error(`getLogs ${from}-${to} exhausted retries`);
}

/* ── Per-network context ───────────────────────────────────────────────────── */

const contexts = new Map();

/**
 * Everything the runtime needs to talk to ONE network.
 * Memoized per network id so providers and caches are shared, not rebuilt.
 */
export function getChainCtx(networkId = DEFAULT_NETWORK) {
  const id = isNetworkId(networkId) ? networkId : DEFAULT_NETWORK;
  const existing = contexts.get(id);
  if (existing) return existing;

  const net = getNetwork(id);
  const provider = buildProvider(net);
  const CHUNK = Number(net.chunkBlocks || 9000);
  // Delay between chunks. A cold backfill is hundreds of sequential getLogs calls,
  // and pacing them is what keeps a shared public endpoint from throttling us at all;
  // steady-state ticks only fetch 0-2 chunks, so this costs nothing once warm.
  const CHUNK_DELAY_MS = Number(process.env.INDEX_CHUNK_DELAY_MS ?? 120);
  const LOOKBACK = BigInt(process.env.INDEX_LOOKBACK_BLOCKS || "500000");
  const FROM_BLOCK = net.indexFromBlock ?? null;

  // Contract addresses, in the shape the rest of the backend already expects.
  const ADDR = {
    usdc: net.addr.usdc,
    escrow: net.addr.escrow,
    agentRegistry: net.addr.agentRegistry,
    bidEngine: net.addr.bidEngine,
    taskRegistry: net.addr.taskRegistry,
    verifierBridge: net.addr.verifierBridge,
    subscriptionManager: net.addr.subscriptionManager,
    agentBadges: net.addr.agentBadges,
    disputeManager: net.addr.disputeManager,
    recurringMarket: net.addr.recurringMarket,
    erc8004Identity: net.addr.erc8004Identity,
    erc8004Reputation: net.addr.erc8004Reputation,
    erc8004Validation: net.addr.erc8004Validation,
    entryPoint: net.addr.entryPoint,
    accountFactory: net.addr.accountFactory,
  };

  /**
   * queryFilter in bounded chunks so we never exceed the RPC's getLogs range cap
   * (Arc caps at 10,000 blocks; BOT Chain answers 10k spans fine but the payload
   * gets large, so the same chunking applies).
   */
  async function queryLogsChunked(contract, filter, lookback, fromBlock) {
    const head = await provider.getBlockNumber();
    const back = lookback ?? Number(LOOKBACK);
    const start = fromBlock ?? (head > back ? head - back : 0);
    const out = [];
    for (let from = start; from <= head; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, head);
      if (from > start && CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
      try {
        out.push(...(await queryOneChunk(contract, filter, from, to)));
      } catch (e) {
        const msg = e.shortMessage || e.message || "";
        if (e.rateLimited) {
          console.warn(`[chain:${id}] getLogs aborted (rate limit) at chunk ${from}-${to}: ${msg}`);
          throw e; // let the caller keep its cache rather than churn the RPC
        }
        console.warn(`[chain:${id}] getLogs chunk ${from}-${to} failed after retries: ${msg}`);
        // skip this chunk (best-effort sweep) and continue
      }
    }
    return out;
  }

  /**
   * Scan a bounded [fromBlock..toBlock] range in chunks for an incremental,
   * checkpointed index. Calls `onChunk(logs, toBlockOfChunk)` after each chunk
   * that fully succeeds, and returns the highest block scanned. On ANY chunk
   * failure it STOPS (never skips) so the caller only advances its checkpoint
   * past ranges it actually read — no silent gaps; the unscanned tail is retried
   * next call.
   */
  async function scanRange(contract, filter, fromBlock, toBlock, onChunk) {
    let lastGood = fromBlock - 1;
    for (let from = fromBlock; from <= toBlock; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, toBlock);
      if (from > fromBlock && CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
      let logs;
      try {
        logs = await queryOneChunk(contract, filter, from, to);
      } catch (e) {
        console.warn(`[chain:${id}] scanRange stopped at ${from}-${to}: ${e.shortMessage || e.message}`);
        break;
      }
      await onChunk(logs, to);
      lastGood = to;
    }
    return lastGood;
  }

  // TaskSubmitted is emitted exactly once per taskId and its fields never change,
  // so a successful lookup can be cached indefinitely — this avoids re-running a
  // chunked eth_getLogs scan (up to ~56 RPC calls) on every /api/verify call.
  // One cache per network: task ids are only unique within a chain.
  const taskMetaCache = new Map();

  /** Read a task's metadata (description/rubric/etc.) from its TaskSubmitted event. */
  async function readTaskMeta(taskId) {
    const key = String(taskId).toLowerCase();
    const cached = taskMetaCache.get(key);
    if (cached) return cached;
    if (!ADDR.taskRegistry) return null;
    const reg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);
    // Explicit fromBlock (deploy block) rather than a rolling lookback window: a
    // task's TaskSubmitted event doesn't become unfindable just because the chain
    // has since advanced past INDEX_LOOKBACK_BLOCKS — Arc's block rate means that
    // window covers only ~1-2 days (BOT Chain's 0.67s blocks, only hours), so
    // without this any older task would 404 out of /api/verify forever, stuck at
    // ASSIGNED (confirmed live on Arc: this is exactly what was happening).
    const logs = await queryLogsChunked(reg, reg.filters.TaskSubmitted(taskId), undefined, FROM_BLOCK ?? undefined);
    if (logs.length === 0) return null;
    const a = logs[logs.length - 1].args;
    const meta = {
      taskId,
      network: id,
      requester: a.requester,
      budgetUsdc: Number(ethers.formatUnits(a.budgetUsdc, net.asset.decimals)),
      deadline: Number(a.deadline) * 1000,
      minReputation: Number(a.minReputation),
      title: a.title,
      description: a.description,
      rubric: a.rubric,
      taskType: a.taskType,
    };
    taskMetaCache.set(key, meta);
    return meta;
  }

  /** The on-chain assigned agent for a task (address or null). */
  async function readAssignedAgent(taskId) {
    if (!ADDR.taskRegistry) return null;
    const reg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);
    const t = await reg.tasks(taskId);
    const agent = t.assignedAgent;
    return agent && agent !== ethers.ZeroAddress ? agent : null;
  }

  function requireAddresses(keys) {
    const missing = keys.filter((k) => !ADDR[k] || ADDR[k] === "0x");
    if (missing.length) {
      throw new Error(
        `Missing contract addresses for ${net.label} (${id}): ${missing.join(", ")}. Deploy to this network and fill its config.`,
      );
    }
  }

  /** A contract handle on this network. `signer` may be a wallet or omitted. */
  function contract(key, abiKey, signer) {
    requireAddresses([key]);
    return new ethers.Contract(ADDR[key], ABI[abiKey], signer ?? provider);
  }

  const ctx = {
    id,
    label: net.label,
    chainId: net.chainId,
    CHAIN_ID: net.chainId,
    explorerUrl: net.explorerUrl,
    asset: net.asset,
    /** Agent collateral floor in wei (native networks); null on ERC-20 networks,
     *  where AgentRegistry's MIN_STAKE constant applies. */
    minStakeWei: net.minStakeWei ?? null,
    gasSymbol: net.gasSymbol,
    provider,
    ADDR,
    ABI,
    chunkBlocks: CHUNK,
    indexFromBlock: FROM_BLOCK,
    /** Deploy block per contract, for indexes that only need one contract's history. */
    fromBlockFor(contractKey) {
      return net.contractFromBlocks?.[contractKey] ?? FROM_BLOCK ?? 0;
    },
    supportsX402: net.supportsX402,
    swarmMode: net.swarmMode,
    /** True where the DEPLOYED contracts verify the pre-audit verdict digests
     *  (Arc). Consumed by server/digests.js — see the note there. */
    legacyVerdictDigest: Boolean(net.legacyVerdictDigest),
    queryLogsChunked,
    scanRange,
    readTaskMeta,
    readAssignedAgent,
    requireAddresses,
    contract,
    /** Signing wallet for verdicts on this network, or null when unconfigured. */
    signer() {
      const key = process.env[net.signerKeyEnv];
      return key ? new ethers.Wallet(key, provider) : null;
    },
  };
  contexts.set(id, ctx);
  return ctx;
}

/** Contexts for every network the runtime is configured to serve. */
export function allChainCtx(ids = NETWORK_IDS) {
  return ids.map((id) => getChainCtx(id));
}

/* ── Backwards-compatible Arc-bound exports ────────────────────────────────────
 * Existing modules import these directly; they resolve to Arc, which is what they
 * meant before multi-chain support existed. New code should take a ctx instead.
 */
const arc = getChainCtx(DEFAULT_NETWORK);

export const RPC_URL = getNetwork(DEFAULT_NETWORK).rpcUrl;
export const CHAIN_ID = arc.chainId;
export const provider = arc.provider;
export const ADDR = arc.ADDR;
export const queryLogsChunked = arc.queryLogsChunked;
export const scanRange = arc.scanRange;
export const readTaskMeta = arc.readTaskMeta;
export const readAssignedAgent = arc.readAssignedAgent;
export const requireAddresses = arc.requireAddresses;
