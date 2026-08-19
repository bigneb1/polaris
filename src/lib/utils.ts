import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Shorten an EVM address: 0x1234…abcd */
export function shortAddr(addr?: string | null, lead = 6, tail = 4): string {
  if (!addr) return "-";
  if (addr.length <= lead + tail) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

/** Format a USDC amount (number already in human units) with thousands + 2dp. */
export function fmtUSDC(amount: number | string | undefined | null): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount ?? 0;
  if (!isFinite(n as number)) return "0.00";
  return (n as number).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Compact number: 1.2K, 3.4M */
export function fmtCompact(n: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Absolute date: "Jun 22" (this year) or "Jun 22, 2026" (other years). */
export function fmtDate(input: number | Date): string {
  const ts = input instanceof Date ? input.getTime() : input < 1e12 ? input * 1000 : input;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Relative time, then absolute. Under a day → "Xs/Xm/Xh ago"; exactly a day →
 * "1d ago"; more than a day → the calendar date it happened (per product spec:
 * recent events read "2s ago", older ones read as their date).
 */
export function timeAgo(input: number | Date): string {
  const ts = input instanceof Date ? input.getTime() : input < 1e12 ? input * 1000 : input;
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "1d ago";
  return fmtDate(ts);
}

/** Deadline countdown: "2d 4h left" or "expired". */
/**
 * Countdown to a task's deadline.
 *
 * `status` (and `attestation`) matter: a deadline only counts down while the task
 * is still live. A finished task has no deadline left to run out, so labelling a
 * SETTLED task "expired" next to its own SETTLED badge — which is what happened
 * before this took the task's state into account — is simply false. For a finished
 * task this returns null and the caller shows something factual instead.
 *
 * For a task that IS still live past its deadline, "overdue" is the accurate word:
 * nothing expires, but the agent is now slashable via slashOnTimeout.
 */
export function deadlineLabel(
  deadlineMs: number,
  task?: { status: string; attestation?: { passed: boolean } },
): string | null {
  if (task && isFinished(task)) return null;
  const diff = deadlineMs - Date.now();
  if (diff <= 0) return "overdue";
  const h = Math.floor(diff / 3.6e6);
  if (h < 24) return `${h}h left`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h left`;
}

/**
 * A task that has reached a terminal state, whatever the outcome: paid out,
 * refunded, or cancelled. Broader than `isDone` (which means "completed AND paid")
 * because a cancelled or failed task is equally finished as far as deadlines and
 * countdowns are concerned.
 */
export function isFinished(task: { status: string; attestation?: { passed: boolean } }): boolean {
  // `attestation?.passed === true`, not merely `attestation != null`, so this agrees
  // with `isDone`: a failing attestation on a task that is still ASSIGNED means the
  // agent may retry, and treating that as finished would hide its live deadline.
  return task.status === "SETTLED" || task.status === "CANCELLED" || task.attestation?.passed === true;
}

/**
 * Bidding window for a task: a fixed 20 minutes from creation (clamped to the
 * remaining time before the deadline), then the auction is awarded and work
 * begins. Mirrors the swarm's BID_WINDOW_MS. Returns remaining bid time + label.
 */
const BID_WINDOW_MS = 20 * 60_000;
export function bidWindow(createdAtMs: number, deadlineMs: number): { closesInMs: number; label: string } {
  const windowMs = Math.min(BID_WINDOW_MS, Math.max(0, deadlineMs - createdAtMs));
  const closesAt = createdAtMs + windowMs;
  const remaining = closesAt - Date.now();
  if (remaining <= 0) return { closesInMs: 0, label: "bidding closed" };
  const m = Math.floor(remaining / 60_000);
  if (m < 60) return { closesInMs: remaining, label: `bidding ${m || 1}m left` };
  const h = Math.floor(m / 60);
  return { closesInMs: remaining, label: `bidding ${h}h ${m % 60}m left` };
}

/**
 * A task is "done" (completed & paid) if it settled on-chain OR carries a passing
 * verifier attestation. The attestation (deliverable hash) is the on-chain proof
 * of completion, so we treat it as done even if the TaskSettled event lagged.
 */
/**
 * Past its deadline and still not resolved.
 *
 * The distinction the UI got wrong: an ASSIGNED task whose deadline has passed is not "in
 * progress", it is overdue, and a task that reads as healthy while nothing can advance it is
 * how a stall goes unnoticed. Terminal states are never overdue, however old they are.
 */
export function isOverdue(task: { status: string; deadlineMs?: number; attestation?: { passed: boolean } }): boolean {
  if (isFinished(task)) return false;
  return typeof task.deadlineMs === "number" && task.deadlineMs < Date.now();
}

export function isDone(task: { status: string; attestation?: { passed: boolean } }): boolean {
  return task.status === "SETTLED" || task.attestation?.passed === true;
}
