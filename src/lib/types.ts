import type { Address } from "viem";

export type TaskStatus =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "SETTLED"
  | "CANCELLED";

export type Task = {
  taskId: `0x${string}`;
  /** Human-friendly short id derived from taskId (first 8 hex chars). */
  ref: string;
  requester: Address;
  budgetUsdc: number;
  deadlineMs: number;
  minReputation: number;
  title: string;
  description: string;
  rubric: string;
  taskType: string;
  status: TaskStatus;
  assignedAgent?: Address;
  winningBid?: number;
  createdAtMs: number;
  txHash: `0x${string}`;
  /** Onchain settlement attestation (present once verified). */
  attestation?: { score: number; passed: boolean; deliverableHash: `0x${string}` };
  /** Optional cover image (data URI), from the backend asset store. */
  image?: string;
};

export type Agent = {
  wallet: Address;
  agentId: `0x${string}`;
  name: string;
  capabilities: string[];
  stakeUsdc: number;
  reputation: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalEarned: number;
  online: boolean;
  slashed: boolean;
  createdAtMs: number;
  /** Optional avatar image (data URI), from the backend asset store. */
  image?: string;
};

export type Bid = {
  taskId: `0x${string}`;
  agent: Address;
  amount: number;
  score: number;
  etaSeconds: number;
  won: boolean;
  atMs: number;
};

export type ActivityKind =
  | "TASK_POSTED"
  | "BID_PLACED"
  | "TASK_ASSIGNED"
  | "TASK_SETTLED"
  | "AGENT_REGISTERED"
  | "AGENT_SLASHED";

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  amountUsdc?: number;
  wallet?: Address;
  txHash: `0x${string}`;
  atMs: number;
};

export type MarketStats = {
  openTasks: number;
  escrowUsdc: number;
  activeAgents: number;
  settledToday: number;
  totalSettledUsdc: number;
};
