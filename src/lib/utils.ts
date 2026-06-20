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

/** Relative time from a unix-seconds or ms timestamp / Date. */
export function timeAgo(input: number | Date): string {
  const ts = input instanceof Date ? input.getTime() : input < 1e12 ? input * 1000 : input;
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Deadline countdown: "2d 4h left" or "expired". */
export function deadlineLabel(deadlineMs: number): string {
  const diff = deadlineMs - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3.6e6);
  if (h < 24) return `${h}h left`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h left`;
}

/**
 * Bidding window for a task: agents bid for the first ~10% of the task's duration
 * (clamped 1 min .. 2 h), then the auction is awarded and work begins. Mirrors the
 * swarm's BID_WINDOW settings. Returns the remaining bid time + a human label.
 */
const BID_WINDOW_FRACTION = 0.1;
const BID_WINDOW_MIN_MS = 60_000;
const BID_WINDOW_MAX_MS = 2 * 60 * 60_000;
export function bidWindow(createdAtMs: number, deadlineMs: number): { closesInMs: number; label: string } {
  const duration = Math.max(0, deadlineMs - createdAtMs);
  const windowMs = Math.min(BID_WINDOW_MAX_MS, Math.max(BID_WINDOW_MIN_MS, duration * BID_WINDOW_FRACTION));
  const closesAt = createdAtMs + windowMs;
  const remaining = closesAt - Date.now();
  if (remaining <= 0) return { closesInMs: 0, label: "bidding closed" };
  const m = Math.floor(remaining / 60_000);
  if (m < 60) return { closesInMs: remaining, label: `bidding ${m || 1}m left` };
  const h = Math.floor(m / 60);
  return { closesInMs: remaining, label: `bidding ${h}h ${m % 60}m left` };
}
