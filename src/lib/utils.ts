import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Shorten an EVM address: 0x1234…abcd */
export function shortAddr(addr?: string | null, lead = 6, tail = 4): string {
  if (!addr) return "—";
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
