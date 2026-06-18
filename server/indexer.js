import { ethers } from "ethers";
import { provider, ADDR, USDC_DECIMALS } from "./chain.js";

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

const LOOKBACK = BigInt(process.env.INDEX_LOOKBACK_BLOCKS || "500000");
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
  const start = head > Number(LOOKBACK) ? BigInt(head) - LOOKBACK : 0n;
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

async function blockTimes(blocks) {
  const uniq = Array.from(new Set(blocks)).slice(-400);
  const map = new Map();
  await Promise.all(
    uniq.map(async (bn) => {
      try {
        const blk = await provider.getBlock(bn);
        if (blk) map.set(bn, Number(blk.timestamp) * 1000);
      } catch {
        /* ignore */
      }
    }),
  );
  return map;
}

export async function buildIndex() {
  const [taskLogs, agentLogs, bidLogs, verifierLogs] = await Promise.all([
    getAllLogs(ADDR.taskRegistry, EVENTS.taskRegistry),
    getAllLogs(ADDR.agentRegistry, EVENTS.agentRegistry),
    getAllLogs(ADDR.bidEngine, EVENTS.bidEngine),
    getAllLogs(ADDR.verifierBridge, EVENTS.verifierBridge),
  ]);

  const allBlocks = [...taskLogs, ...agentLogs, ...bidLogs].map((l) => l.blockNumber).filter((b) => b != null);
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
      if (t) t.status = "SETTLED";
    } else if (log.name === "TaskCancelled") {
      const t = tasks.get(id);
      if (t) t.status = "CANCELLED";
    }
  }

  /* Onchain settlement attestations */
  for (const log of verifierLogs) {
    if (log.name !== "VerificationSubmitted") continue;
    const a = log.args;
    const t = tasks.get(a.taskId);
    if (t) t.attestation = { score: Number(a.score), passed: a.passed, deliverableHash: a.deliverableHash };
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

  return {
    tasks: Array.from(tasks.values()).sort((a, b) => b.createdAtMs - a.createdAtMs),
    agents: Array.from(agents.values()).sort((a, b) => b.reputation - a.reputation),
    bids,
    activity: activity.slice(0, 60),
    indexedAtMs: Date.now(),
  };
}

/* Small in-process cache so frequent polls don't hammer the RPC. */
let cache = null;
let cacheAt = 0;
const TTL_MS = Number(process.env.INDEX_CACHE_MS || "6000");

export async function getIndex() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  cache = await buildIndex();
  cacheAt = now;
  return cache;
}
