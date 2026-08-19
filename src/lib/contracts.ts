import { parseAbi, type Address } from "viem";
import { getNetwork, type ContractKey, type NetworkId } from "./networks";

/**
 * POLARIS CONTRACT REGISTRY
 *
 * Addresses live per-network in src/lib/networks/*.ts and are HARDCODED there —
 * deliberately NOT read from Vite env (VITE_CONTRACT_*). A stale env override
 * (e.g. an old V2/V3 address left on the deploy host) silently points the app at
 * a dead contract: writes go to a contract the indexer doesn't read, so created
 * tasks/agents "vanish". The frontend is rebuilt on every contract change, so the
 * source of truth is those files, not the deployment env.
 *
 * `CONTRACTS` below is Arc's set, kept as a named export so every existing call
 * site keeps compiling and keeps pointing at Arc. Network-aware code should use
 * `contractsFor(networkId)`.
 *
 * Design note: task & agent metadata (title, description, rubric, capabilities)
 * is emitted as strings inside events, so the chain-indexing layer (onchain.ts)
 * can reconstruct the full UI from logs alone - no off-chain database. Only the
 * unbounded deliverable blob lives in the backend, keyed by taskId.
 */
export const CONTRACTS: Record<string, Address> = getNetwork("arc-testnet").contracts as Record<
  string,
  Address
>;

/** Contract set for a network. Values may be null where a network hasn't been
 *  deployed yet — callers must handle that rather than assume an address. */
export function contractsFor(network?: NetworkId | string | null): Record<ContractKey, Address | null> {
  return getNetwork(network).contracts;
}

/** One address, or null when that contract isn't deployed on that network. */
export function contractAddress(key: ContractKey, network?: NetworkId | string | null): Address | null {
  return getNetwork(network).contracts[key];
}

/** Same as `contractAddress` but throws instead of returning null — use at the
 *  point of a write, so a misconfigured network fails loudly and locally rather
 *  than sending a transaction to the zero address. */
export function requireContract(key: ContractKey, network?: NetworkId | string | null): Address {
  const n = getNetwork(network);
  const addr = n.contracts[key];
  if (!addr || addr === "0x") {
    throw new Error(`${key} is not deployed on ${n.label}, this action isn't available here yet.`);
  }
  return addr;
}

export function isDeployed(key: string, network?: NetworkId | string | null): boolean {
  const addr = getNetwork(network).contracts[key as ContractKey];
  return !!addr && addr !== "0x";
}

/** True once the core trio needed to render the market is live on `network`. */
export function coreDeployed(network?: NetworkId | string | null): boolean {
  return isDeployed("taskRegistry", network) && isDeployed("agentRegistry", network);
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

/**
 * Native-value variants, used on networks whose escrow asset is the chain's own
 * coin (BOT Chain). Same signatures as the ERC-20 versions — deliberately, so the
 * event indexer and every read path are identical — but the funding entry points
 * are `payable` and the value arrives with the call instead of being pulled via an
 * allowance. Arc keeps the non-payable ABIs above.
 */
export const NATIVE_TASK_REGISTRY_ABI = parseAbi([
  "function submitTask(bytes32 taskId, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType) payable",
  "function submitDirectTask(bytes32 taskId, address agent, uint256 budgetUsdc, uint256 deadline, string title, string description, string rubric, string taskType) payable",
  "function cancelTask(bytes32 taskId)",
  "function tasks(bytes32) view returns (bytes32 taskId, address requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt, uint256 winningBid)",
  "function slashOnTimeout(bytes32 taskId)",
  "event TaskSubmitted(bytes32 indexed taskId, address indexed requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)",
  "event TaskAssigned(bytes32 indexed taskId, address indexed agent, uint256 bidAmount)",
  "event TaskSettled(bytes32 indexed taskId, address indexed agent, uint256 amount)",
  "event TaskCancelled(bytes32 indexed taskId)",
  "event TaskTimedOut(bytes32 indexed taskId, address indexed agent)",
]);

export const NATIVE_AGENT_REGISTRY_ABI = parseAbi([
  "function register(bytes32 agentId, uint256 stakeAmount, string name, string capabilities) payable",
  "function deactivate()",
  "function withdrawStake()",
  "function restake(uint256 additionalAmount) payable",
  "function agents(address) view returns (address wallet, bytes32 agentId, uint256 stakedUsdc, uint256 reputation, uint256 tasksCompleted, uint256 tasksFailed, uint256 activeTasks, bool online, bool registered)",
  "function getReputation(address wallet) view returns (uint256)",
  "function isOnline(address wallet) view returns (bool)",
  "function getStake(address wallet) view returns (uint256)",
  "function getActiveTasks(address wallet) view returns (uint256)",
  "function MIN_STAKE() view returns (uint256)",
  "event AgentRegistered(address indexed wallet, bytes32 indexed agentId, uint256 stake, string name, string capabilities)",
  "event AgentDeactivated(address indexed wallet)",
  "event AgentRestaked(address indexed wallet, uint256 amount)",
  "event StakeWithdrawn(address indexed wallet, uint256 amount)",
  "event TaskAssignedToAgent(address indexed wallet, uint256 activeTasks)",
  "event ReputationUpdated(address indexed wallet, uint256 newRep)",
  "event AgentSlashed(address indexed wallet, uint256 penalty)",
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

export const DISPUTE_MANAGER_ABI = parseAbi([
  "function openDispute(bytes32 disputeId, bytes32 taskId, address agent, uint256 bond, string reason)",
  "function getDispute(bytes32) view returns (address requester, address agent, bytes32 taskId, uint256 bond, uint8 status)",
  "event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed taskId, address indexed requester, address agent, uint256 bond, string reason)",
  "event DisputeResolved(bytes32 indexed disputeId, bool upheld, string juryNote)",
]);

export const RECURRING_MARKET_ABI = parseAbi([
  "function createPlan(bytes32 planId, uint256 perDelivery, uint32 total, uint256 minReputation, (string title, string brief, string rubric, string taskType, string schedule) meta)",
  "function cancelPlan(bytes32 planId)",
  "function getPlan(bytes32) view returns (address requester, address agent, uint256 perDelivery, uint256 price, uint32 total, uint32 done, uint256 escrowed, uint256 minReputation, uint8 status)",
]);

/**
 * ERC-8004 identity registry, trimmed to what the app calls.
 *
 * `register` mints to `msg.sender`, which is exactly why this belongs in the
 * frontend: the identity has to be owned by the agent's own wallet, and at
 * registration time that wallet is the one connected. Nothing else can mint it on
 * the agent's behalf.
 */
export const ERC8004_IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
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
