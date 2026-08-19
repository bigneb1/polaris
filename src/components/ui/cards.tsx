/**
 * Row and header components shared by the list pages.
 *
 * The list idiom is ProofWork's: one bordered container whose children are separated
 * by `border-t`, rather than a stack of floating cards. At this density it fits far
 * more on a phone and scans like a table, which is what a market of tasks actually is.
 * A row is therefore a full-width flex line, not a card.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Repeat } from "lucide-react";
import type { ActivityEvent, Agent, Task } from "../../lib/types";
import { bidWindow, cn, deadlineLabel, fmtDate, shortAddr, timeAgo } from "../../lib/utils";
import { StatusBadge, USDCAmount } from "./primitives";
import { useAsset } from "../../hooks/useAsset";

/** A page's title block, inside `<main>`. Kept small: the chrome already says where you are. */
export function PageHeader({
  eyebrow,
  title,
  sub,
  action,
}: {
  eyebrow?: string;
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{eyebrow}</div>
        )}
        <h1 className="text-base font-semibold tracking-tight text-foreground">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{sub}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

/** Wraps rows in the single bordered container the list idiom expects. */
export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-[4px] border border-border overflow-hidden", className)}>
      {children}
    </div>
  );
}

/** Shared row chrome: hover, separator, and a consistent click target. */
export function Row({
  to,
  onClick,
  children,
  first,
}: {
  to?: string;
  onClick?: () => void;
  children: ReactNode;
  first?: boolean;
}) {
  const cls = cn(
    "flex w-full items-center gap-2 sm:gap-4 px-3 py-2.5 bg-card text-left transition-colors hover:bg-muted/60",
    !first && "border-t border-border",
    (to || onClick) && "cursor-pointer",
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {children}
      </Link>
    );
  }
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  ) : (
    <div className={cls}>{children}</div>
  );
}

export function TaskItem({ task, first }: { task: Task; first?: boolean }) {
  const bw = task.status === "OPEN" ? bidWindow(task.createdAtMs, task.deadlineMs) : null;
  return (
    <Row to={`/task/${task.taskId}`} first={first}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[13px] font-medium text-foreground">{task.title}</p>
          {task.recurring && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-[3px] border border-secondary/30 bg-secondary/15 px-1.5 text-[10px] text-secondary">
              <Repeat className="h-2.5 w-2.5" /> {task.recurring.deliveries}×
            </span>
          )}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          <span>#{task.ref}</span>
          <span className="uppercase">{task.taskType}</span>
          <span className="hidden xs:inline">· {fmtDate(task.createdAtMs)}</span>
          {/* Only a live task has a countdown; a finished one shows when it settled. */}
          <span className="hidden sm:inline">
            · {deadlineLabel(task.deadlineMs, task) ?? `settled ${fmtDate(task.settledAtMs ?? task.createdAtMs)}`}
          </span>
          {bw && bw.closesInMs > 0 && <span className="text-accent">· bidding {bw.label}</span>}
        </p>
      </div>
      <USDCAmount amount={task.budgetUsdc} size="sm" className="shrink-0 text-foreground" />
      <div className="shrink-0 hidden xs:flex justify-end">
        <StatusBadge status={task.status} />
      </div>
      <ArrowUpRight className="hidden sm:block h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Row>
  );
}

/**
 * A task as a card, for the market's grid view.
 *
 * The row idiom scans like a table and fits more on screen; the card gives the brief
 * room to breathe, which is what helps when you do not already know the market. Both
 * exist because they answer different questions, and the toolbar lets the reader pick.
 */
export function TaskCard({ task }: { task: Task }) {
  const bw = task.status === "OPEN" ? bidWindow(task.createdAtMs, task.deadlineMs) : null;
  return (
    <Link
      to={`/task/${task.taskId}`}
      className="flex flex-col gap-2 rounded-[4px] border border-border bg-card p-3 transition-colors hover:border-primary/30"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-[13px] font-medium text-foreground">{task.title}</p>
        <StatusBadge status={task.status} />
      </div>
      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{task.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        <span className="rounded-[3px] bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {task.taskType}
        </span>
        {task.recurring && (
          <span className="inline-flex items-center gap-1 rounded-[3px] border border-secondary/30 bg-secondary/15 px-1.5 text-[10px] text-secondary">
            <Repeat className="h-2.5 w-2.5" /> {task.recurring.deliveries}×
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {deadlineLabel(task.deadlineMs, task) ?? `settled ${fmtDate(task.settledAtMs ?? task.createdAtMs)}`}
        </span>
        {bw && bw.closesInMs > 0 && <span className="text-[10px] text-accent">bidding {bw.label}</span>}
        <USDCAmount amount={task.budgetUsdc} size="sm" className="ml-auto shrink-0 text-foreground" />
      </div>
    </Link>
  );
}

export function AgentCard({
  agent,
  footer,
  first,
}: {
  agent: Agent;
  footer?: ReactNode;
  /** Kept for call-site compatibility; the row idiom is compact by construction. */
  compact?: boolean;
  first?: boolean;
}) {
  const { symbol } = useAsset();
  return (
    <div className={cn("bg-card", !first && "border-t border-border")}>
      <Link to={`/agent/${agent.wallet}`} className="flex items-center gap-2 sm:gap-4 px-3 py-2.5 transition-colors hover:bg-muted/60">
        <span
          className={cn("status-dot", agent.online ? "bg-success" : "bg-muted-foreground/50")}
          title={agent.online ? "Online" : "Offline"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium text-foreground">{agent.name || shortAddr(agent.wallet)}</p>
            {agent.erc8004Id && (
              <span
                className="shrink-0 rounded-[3px] border border-primary/25 bg-primary/12 px-1.5 text-[10px] text-primary"
                title="Has a portable ERC-8004 identity"
              >
                8004 #{agent.erc8004Id}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {agent.capabilities.slice(0, 3).join(" · ") || "no capabilities"}
          </p>
        </div>
        <span className="hidden md:block shrink-0 text-[11px] text-muted-foreground">
          {agent.tasksCompleted} done
        </span>
        <span className="shrink-0 text-[11px] font-mono text-foreground w-14 text-right">rep {agent.reputation}</span>
        <span className="hidden xs:block shrink-0 text-[11px] text-muted-foreground w-20 text-right">
          {agent.stakeUsdc} {symbol}
        </span>
      </Link>
      {footer && <div className="border-t border-border px-3 py-2">{footer}</div>}
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  TASK_CREATED: "bg-primary",
  BID_PLACED: "bg-secondary",
  TASK_ASSIGNED: "bg-accent",
  TASK_SETTLED: "bg-success",
  AGENT_REGISTERED: "bg-secondary",
  AGENT_SLASHED: "bg-destructive",
};

export function FeedItem({ ev, first }: { ev: ActivityEvent; first?: boolean }) {
  return (
    <Row first={first}>
      <span className={cn("status-dot mt-1.5 self-start", KIND_TONE[ev.kind] ?? "bg-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-foreground">{ev.title}</p>
        {ev.detail && <p className="truncate font-mono text-[11px] text-muted-foreground">{ev.detail}</p>}
      </div>
      {ev.amountUsdc != null && <USDCAmount amount={ev.amountUsdc} size="sm" className="shrink-0" />}
      <span className="shrink-0 text-[11px] text-muted-foreground w-16 text-right">{timeAgo(ev.atMs)}</span>
    </Row>
  );
}
