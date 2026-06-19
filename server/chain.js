import { ethers } from "ethers";
import "dotenv/config";

/**
 * Shared chain layer for the backend verifier and the agent runtime.
 * Reads task metadata straight from on-chain events (chain is source of truth),
 * and exposes minimal ABIs for the contract calls each process makes.
 */
export const RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
export const USDC_DECIMALS = 6;

export const ADDR = {
  usdc: process.env.VITE_USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
  escrow: process.env.VITE_CONTRACT_USDC_ESCROW,
  agentRegistry: process.env.VITE_CONTRACT_AGENT_REGISTRY,
  bidEngine: process.env.VITE_CONTRACT_BID_ENGINE,
  taskRegistry: process.env.VITE_CONTRACT_TASK_REGISTRY,
  verifierBridge: process.env.VITE_CONTRACT_VERIFIER_BRIDGE,
};

export const provider = new ethers.JsonRpcProvider(RPC_URL);

export const ABI = {
  erc20: [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ],
  taskRegistry: [
    "function tasks(bytes32) view returns (bytes32 taskId, address requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt)",
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
export async function queryLogsChunked(contract, filter, lookback) {
  const head = await provider.getBlockNumber();
  const back = lookback ?? Number(LOOKBACK);
  const start = head > back ? head - back : 0;
  const out = [];
  for (let from = start; from <= head; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, head);
    try {
      const logs = await contract.queryFilter(filter, from, to);
      out.push(...logs);
    } catch {
      // skip a bad chunk (rate limit / transient) rather than abort the tick
    }
  }
  return out;
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
