/**
 * Polaris shared UI primitives - the design-system building blocks referenced
 * across every page. Kept in one file so the vocabulary stays consistent.
 */
import type { ReactNode } from "react";
import { cn, fmtUSDC } from "../../lib/utils";

/* ── USDC amount with the Circle mark ─────────────────────────────────────── */
export function USDCAmount({
  amount,
  size = "md",
  className,
}: {
  amount: number | string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const dims = { sm: 14, md: 18, lg: 24, xl: 34 }[size];
  const text = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-2xl",
    xl: "text-4xl",
  }[size];
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold", text, className)}>
      <svg width={dims} height={dims} viewBox="0 0 24 24" className="shrink-0">
        <circle cx="12" cy="12" r="12" fill="#2775CA" />
        <path
          d="M12 5.2c-.5 0-.9.4-.9.9v.5c-1.6.2-2.7 1.1-2.7 2.5 0 1.6 1.2 2.2 2.9 2.6 1.3.3 1.6.6 1.6 1.1 0 .5-.5.9-1.3.9-1 0-1.6-.4-1.8-1-.1-.4-.4-.6-.8-.6-.5 0-.9.4-.8.9.2 1.1 1.1 1.8 2.4 2v.5c0 .5.4.9.9.9s.9-.4.9-.9v-.5c1.7-.2 2.8-1.2 2.8-2.6 0-1.6-1.2-2.3-3-2.7-1.2-.3-1.5-.6-1.5-1 0-.5.4-.8 1.2-.8.8 0 1.3.3 1.5.9.1.3.4.5.8.5.5 0 .9-.5.7-1-.3-.9-1-1.5-2-1.7v-.5c0-.5-.4-.9-.9-.9z"
          fill="#fff"
        />
      </svg>
      <span className="mono">{fmtUSDC(amount)}</span>
    </span>
  );
}

/* ── Status badges ────────────────────────────────────────────────────────── */
const STATUS_STYLES: Record<string, string> = {
  OPEN: "text-blue-l border-blue/40 bg-blue/10",
  ASSIGNED: "text-violet border-purple/40 bg-purple/10",
  IN_PROGRESS: "text-amber border-amber/40 bg-amber/10",
  COMPLETED: "text-green border-green/40 bg-green/10",
  SETTLED: "text-green border-green/40 bg-green/10",
  CANCELLED: "text-grey border-border2 bg-deep",
  SLASHED: "text-red border-red/40 bg-red/10",
  ONLINE: "text-green border-green/40 bg-green/10",
  OFFLINE: "text-grey border-border2 bg-deep",
  PENDING: "text-amber border-amber/40 bg-amber/10",
  WON: "text-green border-green/40 bg-green/10",
  LOST: "text-grey border-border2 bg-deep",
};

export function StatusBadge({ status }: { status: string }) {
  const s = status?.toUpperCase() ?? "OPEN";
  return (
    <span
      className={cn(
        "mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
        STATUS_STYLES[s] ?? STATUS_STYLES.OPEN,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.replace("_", " ")}
    </span>
  );
}

/* ── StatCard ─────────────────────────────────────────────────────────────── */
const ACCENTS: Record<string, string> = {
  blue: "before:bg-blue",
  violet: "before:bg-violet",
  green: "before:bg-green",
  amber: "before:bg-amber",
  usdc: "before:bg-usdc",
};

export function StatCard({
  label,
  value,
  sub,
  accent = "blue",
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: keyof typeof ACCENTS;
}) {
  return (
    <div
      className={cn(
        "panel panel-hover relative overflow-hidden p-5",
        "before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:content-['']",
        ACCENTS[accent],
      )}
    >
      <div className="eyebrow">{label}</div>
      <div className="mono mt-2 text-3xl font-bold tracking-tight text-white">{value}</div>
      {sub && <div className="mono mt-1 text-xs text-grey-l">{sub}</div>}
    </div>
  );
}

/* ── Panel with header ────────────────────────────────────────────────────── */
export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="eyebrow !text-grey-l">{title}</h3>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ── ProgressBar ──────────────────────────────────────────────────────────── */
export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-deep">
      <div
        className="h-full rounded-full bg-blue-violet transition-all duration-700"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ── Reputation bar (0-1000 scale) ────────────────────────────────────────── */
export function ReputationBar({ rep }: { rep: number }) {
  const pct = Math.max(0, Math.min(100, (rep / 1000) * 100));
  const color = rep >= 700 ? "bg-green" : rep >= 400 ? "bg-blue" : "bg-amber";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-deep">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-xs text-grey-l">{rep}</span>
    </div>
  );
}

/* ── Loading skeleton ─────────────────────────────────────────────────────── */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-deep", className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-border2/40 to-transparent" />
    </div>
  );
}

/* ── Empty state ──────────────────────────────────────────────────────────── */
export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-grey">{icon}</div>}
      <div className="text-lg font-semibold text-grey-l">{title}</div>
      {message && <p className="max-w-sm text-sm text-grey">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
