import { parseAbi, type Address } from "viem";

/**
 * POLARIS CONTRACT REGISTRY (Arc Network)
 *
 * Addresses are read from Vite env (VITE_CONTRACT_*) so the same build promotes
 * across deployments. They default to "0x" (undeployed) until the Hardhat deploy
 * script fills them in - the UI surfaces a "contracts not deployed" state rather
 * than throwing when they are absent.
 *
 * Design note: task & agent metadata (title, description, rubric, capabilities)
 * is emitted as strings inside events, so the chain-indexing layer (onchain.ts)
 * can reconstruct the full UI from logs alone - no off-chain database. Only the
 * unbounded deliverable blob lives in the backend, keyed by taskId.
 */
const e = (import.meta as { env?: Record<string, string> }).env ?? {};

function addr(key: string, fallback: Address = "0x" as Address): Address {
  const v = e[key];
  return (v && v !== "0x" ? v : fallback) as Address;
}

// Deployed V2 addresses on Arc testnet are baked in as defaults so a fresh
// deploy renders the live market even before any VITE_CONTRACT_* env vars are
// set. Env values still override (e.g. for a future redeploy).
export const CONTRACTS = {
  usdc: addr("VITE_USDC_ADDRESS", "0x3600000000000000000000000000000000000000"),
  usdcEscrow: addr("VITE_CONTRACT_USDC_ESCROW", "0x2256D1F95f59DA5C23F2D8B18e138e339171C76E"),
  agentRegistry: addr("VITE_CONTRACT_AGENT_REGISTRY", "0x2b27E33cf288a6cFCD19234b16827CC234497fCA"),
  bidEngine: addr("VITE_CONTRACT_BID_ENGINE", "0xC6D21ec2678B19d02d1207970aCf343f05C24984"),
  taskRegistry: addr("VITE_CONTRACT_TASK_REGISTRY", "0x1cc2ac9d45c7B1d261C05df5bf16E778B93DAA35"),
  verifierBridge: addr("VITE_CONTRACT_VERIFIER_BRIDGE", "0xa04D9F64A96112B983c7ADdF7a20C22b72edF875"),
  revenueRouter: addr("VITE_CONTRACT_REVENUE_ROUTER", "0xED6d1aF5556a4407B09776cd64d28098880c7EAa"),
} as const;

export function isDeployed(key: keyof typeof CONTRACTS): boolean {
  return CONTRACTS[key] !== "0x";
}

/** True once the core trio needed to render the market is live. */
export function coreDeployed(): boolean {
  return isDeployed("taskRegistry") && isDeployed("agentRegistry");
}

/* ── ABIs (human-readable; must match contracts/*.sol exactly) ───────────────── */

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const TASK_REGISTRY_ABI = parseAbi([
  "function submitTask(bytes32 taskId, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)",
  "function cancelTask(bytes32 taskId)",
  "function tasks(bytes32) view returns (bytes32 taskId, address requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt)",
  "function submitDirectTask(bytes32 taskId, address agent, uint256 budgetUsdc, uint256 deadline, string title, string description, string rubric, string taskType)",
  "function slashOnTimeout(bytes32 taskId)",
  "event TaskSubmitted(bytes32 indexed taskId, address indexed requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)",
  "event TaskAssigned(bytes32 indexed taskId, address indexed agent, uint256 bidAmount)",
  "event TaskSettled(bytes32 indexed taskId, address indexed agent, uint256 amount)",
  "event TaskCancelled(bytes32 indexed taskId)",
  "event TaskTimedOut(bytes32 indexed taskId, address indexed agent)",
]);

export const AGENT_REGISTRY_ABI = parseAbi([
  "function register(bytes32 agentId, uint256 stakeAmount, string name, string capabilities)",
  "function deactivate()",
  "function withdrawStake()",
  "function restake(uint256 additionalAmount)",
  "function agents(address) view returns (address wallet, bytes32 agentId, uint256 stakedUsdc, uint256 reputation, uint256 tasksCompleted, uint256 tasksFailed, uint256 activeTasks, bool online, bool registered)",
  "function getReputation(address wallet) view returns (uint256)",
  "function isOnline(address wallet) view returns (bool)",
  "function getStake(address wallet) view returns (uint256)",
  "function getActiveTasks(address wallet) view returns (uint256)",
  "event AgentRegistered(address indexed wallet, bytes32 indexed agentId, uint256 stake, string name, string capabilities)",
  "event AgentDeactivated(address indexed wallet)",
  "event AgentRestaked(address indexed wallet, uint256 amount)",
  "event StakeWithdrawn(address indexed wallet, uint256 amount)",
  "event TaskAssignedToAgent(address indexed wallet, uint256 activeTasks)",
  "event ReputationUpdated(address indexed wallet, uint256 newRep)",
  "event AgentSlashed(address indexed wallet, uint256 penalty)",
]);

export const BID_ENGINE_ABI = parseAbi([
  "function placeBid(bytes32 taskId, uint256 bidAmount, uint256 etaSeconds)",
  "function awardBid(bytes32 taskId)",
  "function bidCount(bytes32 taskId) view returns (uint256)",
  "function auctionClosed(bytes32) view returns (bool)",
  "event BidPlaced(bytes32 indexed taskId, address indexed agent, uint256 amount, uint256 score, uint256 etaSeconds)",
  "event BidAwarded(bytes32 indexed taskId, address indexed winner, uint256 amount)",
]);

export const VERIFIER_BRIDGE_ABI = parseAbi([
  "function submitVerification(bytes32 taskId, address agent, address requester, bool passed, uint8 score, bytes32 deliverableHash, bytes signature)",
  "function processed(bytes32) view returns (bool)",
  "function attestations(bytes32) view returns (address agent, bool passed, uint8 score, bytes32 deliverableHash, uint256 timestamp)",
  "event VerificationSubmitted(bytes32 indexed taskId, address indexed agent, bool passed, uint8 score, bytes32 deliverableHash)",
]);
