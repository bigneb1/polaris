import { ethers } from "ethers";
import "dotenv/config";

/**
 * Shared chain layer for the backend verifier and the agent runtime.
 * Reads task metadata straight from on-chain events (chain is source of truth),
 * and exposes minimal ABIs for the contract calls each process makes.
 */
// Arc public RPC — always kept as the last-resort fallback so a rate-limited or
// down primary degrades instead of taking the whole backend offline.
const PUBLIC_ARC_RPC = "https://rpc.testnet.arc.network";
// Primary endpoint(s): ARC_RPC_URL (comma-separated list allowed, e.g. a dedicated
// QuickNode/Alchemy key first). The Arc public RPC is appended as a fallback below.
export const RPC_URL = process.env.ARC_RPC_URL || PUBLIC_ARC_RPC;
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);
export const USDC_DECIMALS = 6;

export const ADDR = {
  usdc: process.env.VITE_USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
  escrow: process.env.VITE_CONTRACT_USDC_ESCROW,
  agentRegistry: process.env.VITE_CONTRACT_AGENT_REGISTRY,
  bidEngine: process.env.VITE_CONTRACT_BID_ENGINE,
  taskRegistry: process.env.VITE_CONTRACT_TASK_REGISTRY,
  verifierBridge: process.env.VITE_CONTRACT_VERIFIER_BRIDGE,
  // Phase A — recurring tasks. Falls back to the deployed address so the runtime
  // works even before the Railway env var is set.
  subscriptionManager:
    process.env.VITE_CONTRACT_SUBSCRIPTION_MANAGER || "0x3DbA6eD862d4247A30D6dF76d438bEeC72cfb61a",
  // Phase D — agent verification tiers.
  agentBadges:
    process.env.VITE_CONTRACT_AGENT_BADGES || "0x6c5f75992390079A0A0aaD51059D7bA05Dc1b842",
  // Phase C — staked dispute resolution.
  disputeManager:
    process.env.VITE_CONTRACT_DISPUTE_MANAGER || "0xD965F54429a83F80D46462342B24f1814FeBBf05",
  // Recurring market — auctioned recurring tasks with per-delivery release.
  recurringMarket:
    process.env.VITE_CONTRACT_RECURRING_MARKET || "0xD0DBF9323f7275305868f4f83AaCF1160d2B20Fd",
};

// A static network avoids a per-provider eth_chainId detection round-trip (which
// itself fails under rate limits — the "failed to detect network" startup crash)
// and saves RPC budget.
const NETWORK = ethers.Network.from({ chainId: CHAIN_ID, name: "arc-testnet" });

/**
 * Build a failover provider: try the configured primary endpoint(s) first, then
 * fall back to the Arc public RPC. quorum:1 means the first endpoint to answer
 * wins (failover, not consensus), and a stalled endpoint is skipped to the next.
 */
function buildProvider() {
  const primaries = RPC_URL.split(",").map((u) => u.trim()).filter(Boolean);
  const urls = [...new Set([...primaries, PUBLIC_ARC_RPC])]; // Arc public RPC = final fallback
  const stall = Number(process.env.RPC_STALL_MS || 3000);
  const subs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, NETWORK, { staticNetwork: NETWORK }),
    priority: i + 1, // lower number is tried first
    weight: 1,
    stallTimeout: stall,
  }));
  // A single URL needs no FallbackProvider overhead.
  if (subs.length === 1) return subs[0].provider;
  console.log(`[chain] RPC failover: ${urls.join(" → ")}`);
  return new ethers.FallbackProvider(subs, NETWORK, { quorum: 1 });
}

export const provider = buildProvider();

export const ABI = {
  erc20: [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ],
  taskRegistry: [
    "function tasks(bytes32) view returns (bytes32 taskId, address requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt, uint256 winningBid)",
    "function reopenTask(bytes32 taskId)",
    "event TaskSubmitted(bytes32 indexed taskId, address indexed requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)",
    "event TaskAssigned(bytes32 indexed taskId, address indexed agent, uint256 bidAmount)",
    "event TaskReopened(bytes32 indexed taskId)",
  ],
  agentRegistry: [
    "function register(bytes32,uint256,string,string)",
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

const LOOKBACK = BigInt(process.env.INDEX_LOOKBACK_BLOCKS || "500000");
// Arc public RPC caps eth_getLogs at a 10,000-block range — query in chunks.
const CHUNK = Number(process.env.INDEX_CHUNK_BLOCKS || "9000");

/**
 * queryFilter in bounded chunks so we never exceed the RPC's getLogs range cap.
 * @param {import('ethers').Contract} contract
 * @param {import('ethers').DeferredTopicFilter|any} filter
 * @param {number} [lookback] blocks back from head to scan (default INDEX_LOOKBACK_BLOCKS)
 */
/** One bounded getLogs call, retried on transient errors. Throws with
 *  `.rateLimited = true` on a daily-quota / 429 rejection (don't retry those —
 *  it only burns more of an exhausted budget). */
async function queryOneChunk(contract, filter, from, to) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await contract.queryFilter(filter, from, to);
    } catch (e) {
      const msg = e.shortMessage || e.message || "";
      if (e.error?.code === -32003 || e.error?.code === -32005 || /limit|quota|429/i.test(msg)) {
        e.rateLimited = true;
        throw e;
      }
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

export async function queryLogsChunked(contract, filter, lookback) {
  const head = await provider.getBlockNumber();
  const back = lookback ?? Number(LOOKBACK);
  const start = head > back ? head - back : 0;
  const out = [];
  for (let from = start; from <= head; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, head);
    try {
      out.push(...(await queryOneChunk(contract, filter, from, to)));
    } catch (e) {
      const msg = e.shortMessage || e.message || "";
      if (e.rateLimited) {
        console.warn(`[chain] getLogs aborted (rate limit) at chunk ${from}-${to}: ${msg}`);
        throw e; // let the caller keep its cache rather than churn the RPC
      }
      console.warn(`[chain] getLogs chunk ${from}-${to} failed after retries: ${msg}`);
      // skip this chunk (best-effort sweep) and continue
    }
  }
  return out;
}

/**
 * Scan a bounded [fromBlock..toBlock] range in chunks for an incremental,
 * checkpointed index. Calls `onChunk(logs, toBlockOfChunk)` after each chunk that
 * fully succeeds, and returns the highest block scanned. On ANY chunk failure it
 * STOPS (never skips) so the caller only advances its checkpoint past ranges it
 * actually read — no silent gaps; the unscanned tail is retried next call.
 */
export async function scanRange(contract, filter, fromBlock, toBlock, onChunk) {
  let lastGood = fromBlock - 1;
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    let logs;
    try {
      logs = await queryOneChunk(contract, filter, from, to);
    } catch (e) {
      console.warn(`[chain] scanRange stopped at ${from}-${to}: ${e.shortMessage || e.message}`);
      break;
    }
    await onChunk(logs, to);
    lastGood = to;
  }
  return lastGood;
}

/** Read a task's metadata (description/rubric/etc.) from its TaskSubmitted event. */
export async function readTaskMeta(taskId) {
  const reg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);
  const logs = await queryLogsChunked(reg, reg.filters.TaskSubmitted(taskId));
  if (logs.length === 0) return null;
  const a = logs[logs.length - 1].args;
  return {
    taskId,
    requester: a.requester,
    budgetUsdc: Number(ethers.formatUnits(a.budgetUsdc, USDC_DECIMALS)),
    deadline: Number(a.deadline) * 1000,
    minReputation: Number(a.minReputation),
    title: a.title,
    description: a.description,
    rubric: a.rubric,
    taskType: a.taskType,
  };
}

/** The on-chain assigned agent for a task (address or null). */
export async function readAssignedAgent(taskId) {
  const reg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);
  const t = await reg.tasks(taskId);
  const agent = t.assignedAgent;
  return agent && agent !== ethers.ZeroAddress ? agent : null;
}

export function requireAddresses(keys) {
  const missing = keys.filter((k) => !ADDR[k] || ADDR[k] === "0x");
  if (missing.length) {
    throw new Error(`Missing contract addresses in env: ${missing.join(", ")}. Run the deploy script and fill .env.`);
  }
}
