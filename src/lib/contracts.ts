import { parseAbi, type Address } from "viem";

/**
 * POLARIS CONTRACT REGISTRY (Arc Network)
 *
 * Current Arc-testnet (V4) addresses are HARDCODED here — deliberately NOT read
 * from Vite env (VITE_CONTRACT_*). A stale env override (e.g. an old V2/V3 address
 * left on the deploy host) silently points the app at a dead contract: writes go
 * to a contract the indexer doesn't read, so created tasks/agents "vanish". The
 * frontend is rebuilt on every contract change, so the source of truth is this
 * file, not the deployment env.
 *
 * Design note: task & agent metadata (title, description, rubric, capabilities)
 * is emitted as strings inside events, so the chain-indexing layer (onchain.ts)
 * can reconstruct the full UI from logs alone - no off-chain database. Only the
 * unbounded deliverable blob lives in the backend, keyed by taskId.
 */
export const CONTRACTS: Record<string, Address> = {
  usdc: "0x3600000000000000000000000000000000000000",
  usdcEscrow: "0xE9955f2A7fEcFC47844a5cDbbF39f424e2917c74",
  agentRegistry: "0xEb27dBC89529Bab0365a635F29Ffc720Eb87C470",
  bidEngine: "0x5A1D8e1eb034494849e2846800FDF2b27d1fCDd9",
  taskRegistry: "0xe3ad52025F740599A5b02ffD394514fBD3E80F9C",
  verifierBridge: "0xA8C2Cd1D3dd31637e5b9138D856508444E826C3A",
  revenueRouter: "0xe26f6beE50A181211291E903D9EA792a02C4b296",
  // Phase A — recurring tasks & subscriptions (self-custodial; reuses the verifier signer).
  subscriptionManager: "0x3DbA6eD862d4247A30D6dF76d438bEeC72cfb61a",
};

export function isDeployed(key: string): boolean {
  return !!CONTRACTS[key] && CONTRACTS[key] !== "0x";
}

/** True once the core trio needed to render the market is live. */
export function coreDeployed(): boolean {
  return isDeployed("taskRegistry") && isDeployed("agentRegistry");
}

/* ── ABIs (human-readable; must match contracts/*.sol exactly) ───────────────── */

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
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

export const SUBSCRIPTION_MANAGER_ABI = parseAbi([
  "function createSubscription(bytes32 subId, address agent, uint256 perDeliveryUsdc, uint32 totalDeliveries, (string title, string brief, string rubric, string taskType, string schedule) meta)",
  "function cancelSubscription(bytes32 subId)",
  "function recordDelivery(bytes32 subId, uint32 index, bytes32 deliverableHash, uint8 score, bytes signature)",
  "function getSubscription(bytes32 subId) view returns (address subscriber, address agent, uint256 perDeliveryUsdc, uint32 totalDeliveries, uint32 deliveriesDone, uint256 escrowed, bool active)",
  "event SubscriptionCreated(bytes32 indexed subId, address indexed subscriber, address indexed agent, uint256 perDeliveryUsdc, uint32 totalDeliveries, string title, string brief, string rubric, string taskType, string schedule)",
  "event DeliveryReleased(bytes32 indexed subId, address indexed agent, uint32 index, uint256 amount, uint8 score, bytes32 deliverableHash)",
  "event SubscriptionCancelled(bytes32 indexed subId, uint256 refund)",
]);
