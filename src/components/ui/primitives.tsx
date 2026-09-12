/**
 * Shared vocabulary for the app's surfaces, in the ProofWork idiom: dense, mono for
 * anything machine-generated, and semantic status colours.
 *
 * Export names and props are unchanged from the previous design system on purpose, so
 * the routes needed a layout pass rather than an API migration.
 */
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn, fmtUSDC } from "../../lib/utils";
import { useNetwork } from "../../context/NetworkProvider";

/**
 * An amount in the active network's escrow asset.
 *
 * The ticker comes from the network, never hardcoded: it is USDC on Arc and native BOT
 * on BOT Chain. `symbol` overrides it where an amount belongs to a specific network
 * rather than the active one.
 */
export function USDCAmount({
  amount,
  size = "sm",
  className,
  symbol,
}: {
  amount: number | string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  symbol?: string;
}) {
  const { network } = useNetwork();
  const ticker = symbol ?? network.assets.find((a) => a.isEscrowAsset)?.symbol ?? "USDC";
  const text = {
    sm: "text-xs",
    md: "text-[13px]",
    lg: "text-base",
    xl: "text-xl sm:text-2xl",
  }[size];
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-medium", text, className)}>
      <span className="font-mono">{fmtUSDC(amount)}</span>
      <span className="text-muted-foreground text-[0.85em]">{ticker}</span>
    </span>
  );
}

/**
 * A task, subscription, plan or dispute state.
 *
 * Polaris's four on-chain task states map onto the badge vocabulary shared with
 * ProofWork. A SETTLED task reads as "Completed" because that is what it means to a
 * user; it is a label, not a fifth state (see `TaskStatus` in lib/types.ts).
 */
const STATUS_CLASS: Record<string, string> = {
  OPEN: "status-open",
  ASSIGNED: "status-claimed",
  SETTLED: "status-verified",
  CANCELLED: "status-rejected",
  // Subscriptions and recurring plans
  ACTIVE: "status-claimed",
  COMPLETE: "status-verified",
  // Disputes
  UPHELD: "status-verified",
  REJECTED: "status-rejected",
  PENDING: "status-submitted",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  ASSIGNED: "In progress",
  SETTLED: "Completed",
  CANCELLED: "Cancelled",
  ACTIVE: "Active",
  COMPLETE: "Complete",
  UPHELD: "Upheld",
  REJECTED: "Rejected",
  PENDING: "Under review",
};

/**
 * A task's state, told honestly.
 *
 * `overdue` matters: a task past its deadline that has not settled is not "In progress", and
 * calling it that is what made a stalled task look healthy. An overdue ASSIGNED task reads
 * **Overdue** (the runtime's reaper refunds the requester and slashes the agent), and an OPEN
 * task nobody bid on reads **Expired** (only the requester can reclaim it, so the task page
 * offers them that action). Passed in rather than computed, so reading the clock stays in the
 * data helpers where `isOverdue` lives.
 */
export function StatusBadge({ status, overdue = false }: { status: string; overdue?: boolean }) {
  const key = String(status).toUpperCase();

  const label = overdue && key === "ASSIGNED" ? "Overdue" : overdue && key === "OPEN" ? "Expired" : (STATUS_LABEL[key] ?? status);
  const cls = overdue && (key === "ASSIGNED" || key === "OPEN") ? "status-disputed" : (STATUS_CLASS[key] ?? "status-submitted");

  return <span className={cn("status-badge", cls)}>{label}</span>;
}

/** A single figure with its label. Used in tight rows of three or four. */
export function StatCard({
  label,
  value,
  accent = "blue",
}: {
  label: string;
  value: ReactNode;
  accent?: "blue" | "green" | "violet" | "usdc" | "amber";
}) {
  const tone = {
    blue: "text-primary",
    green: "text-success",
    violet: "text-secondary",
    usdc: "text-foreground",
    amber: "text-accent",
  }[accent];
  return (
    <div className="rounded-[4px] border border-border bg-card px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold", tone)}>{value}</div>
    </div>
  );
}

/** A titled content block. */
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
    <section className={cn("rounded-[4px] border border-border bg-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 h-9">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Reputation, 0 to 1000, with the bid floor marked.
 *
 * The colour changes at 70 because that is the on-chain threshold below which
 * BidEngine refuses a bid, so the bar shows eligibility rather than just a number.
 */
export function ReputationBar({ rep }: { rep: number }) {
  const pct = Math.max(0, Math.min(100, (rep / 1000) * 100));
  const eligible = rep >= 70;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">Reputation</span>
        <span className={cn("font-mono", eligible ? "text-success" : "text-destructive")}>{rep}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", eligible ? "bg-success" : "bg-destructive")}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!eligible && <p className="text-[10px] text-destructive">Below the 70 floor, so this agent cannot bid.</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-[4px] bg-muted", className)} />;
}

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
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="mb-3 text-muted-foreground/50">{icon}</div>}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {message && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{message}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ message }: { message?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-[4px] border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <span>{message ?? "Something went wrong. Please try again."}</span>
    </div>
  );
}
