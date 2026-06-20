import { Link } from "react-router-dom";
import { ArrowUpRight, Zap, CheckCircle2, Coins, Bot, Gavel } from "lucide-react";
import type { ReactNode } from "react";
import type { Task, Agent, ActivityEvent } from "../../lib/types";
import { USDCAmount, StatusBadge, ReputationBar } from "./primitives";
import { shortAddr, timeAgo, deadlineLabel, bidWindow, cn } from "../../lib/utils";
import { AgentAvatarImg } from "../AgentAvatar";

/* ── Page header ──────────────────────────────────────────────────────────── */
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
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-3xl font-bold tracking-tightest text-white md:text-4xl">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-sm text-grey-l">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ── TaskItem ─────────────────────────────────────────────────────────────── */
const STATUS_DOT: Record<string, string> = {
  OPEN: "bg-blue",
  ASSIGNED: "bg-violet",
  IN_PROGRESS: "bg-amber",
  COMPLETED: "bg-green",
  SETTLED: "bg-green",
  CANCELLED: "bg-grey",
};

export function TaskItem({ task }: { task: Task }) {
  return (
    <Link
      to={`/task/${task.taskId}`}
      className="panel panel-hover group block overflow-hidden px-4 py-3.5 sm:px-5 sm:py-4"
    >
      {/* Row 1: dot + title (truncates) + status */}
      <div className="flex items-center gap-3">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", STATUS_DOT[task.status] ?? "bg-grey")} />
        <h4 className="min-w-0 flex-1 truncate font-semibold text-white">{task.title}</h4>
        <StatusBadge status={task.status} />
        <ArrowUpRight size={16} className="hidden shrink-0 text-grey transition-colors group-hover:text-blue-l sm:block" />
      </div>
      {/* Row 2: meta (wraps) + budget */}
      <div className="mt-2 flex items-end justify-between gap-3 pl-5">
        <div className="mono flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-grey">
          <span className="mono text-[10px] text-grey">#{task.ref}</span>
          <span className="uppercase tracking-wider text-grey-l">{task.taskType}</span>
          <span>·</span>
          <span>{deadlineLabel(task.deadlineMs)}</span>
          <span>·</span>
          <span>min rep {task.minReputation}</span>
          {task.status === "OPEN" &&
            (() => {
              const bw = bidWindow(task.createdAtMs, task.deadlineMs);
              return (
                <span
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 text-[10px]",
                    bw.closesInMs > 0
                      ? "border-amber/40 bg-amber/10 text-amber"
                      : "border-border bg-deep text-grey",
                  )}
                >
                  {bw.closesInMs > 0 ? `⏳ ${bw.label}` : "bidding closed"}
                </span>
              );
            })()}
        </div>
        <USDCAmount amount={task.budgetUsdc} size="md" className="shrink-0 text-white" />
      </div>
    </Link>
  );
}

/* ── AgentCard ────────────────────────────────────────────────────────────── */
export function AgentCard({ agent, footer, compact }: { agent: Agent; footer?: ReactNode; compact?: boolean }) {
  if (compact) {
    return (
      <Link
        to={`/agent/${agent.wallet}`}
        className="panel panel-hover group flex items-center gap-3 p-3.5"
      >
        <AgentAvatarImg agent={agent} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-white group-hover:text-blue-l">{agent.name}</span>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", agent.slashed ? "bg-red" : agent.online ? "bg-green" : "bg-grey")} />
          </div>
          <div className="mono truncate text-[10px] text-grey">
            {agent.capabilities.slice(0, 2).join(" · ") || shortAddr(agent.wallet)}
          </div>
        </div>
        <div className="text-right">
          <div className="mono text-sm font-bold text-white">{agent.reputation}</div>
          <div className="eyebrow !text-[8px]">rep</div>
        </div>
        <div className="text-right">
          <div className="mono text-sm font-bold text-green">${agent.totalEarned.toFixed(0)}</div>
          <div className="eyebrow !text-[8px]">earned</div>
        </div>
      </Link>
    );
  }
  return (
    <div className="panel panel-hover flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/agent/${agent.wallet}`} className="flex items-center gap-3 group">
          <AgentAvatarImg agent={agent} size={44} />
          <div>
            <div className="font-semibold text-white group-hover:text-blue-l">{agent.name}</div>
            <div className="mono text-[11px] text-grey">{shortAddr(agent.wallet)}</div>
          </div>
        </Link>
        <StatusBadge status={agent.slashed ? "SLASHED" : agent.online ? "ONLINE" : "OFFLINE"} />
      </div>

      <div>
        <div className="eyebrow mb-1.5 flex justify-between">
          <span>Reputation</span>
        </div>
        <ReputationBar rep={agent.reputation} />
      </div>

      {agent.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {agent.capabilities.slice(0, 4).map((c) => (
            <span
              key={c}
              className="mono rounded-md border border-border bg-deep px-2 py-0.5 text-[10px] text-grey-l"
            >
              {c}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
        <Stat label="Done" value={agent.tasksCompleted} />
        <Stat label="Failed" value={agent.tasksFailed} />
        <Stat label="Stake" value={`$${agent.stakeUsdc.toFixed(0)}`} />
      </div>
      <div className="mono text-center text-[11px] text-grey">
        earned <span className="text-green">${agent.totalEarned.toFixed(2)}</span> USDC
      </div>
      {footer}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="mono text-lg font-bold text-white">{value}</div>
      <div className="eyebrow !text-[9px]">{label}</div>
    </div>
  );
}

/* ── FeedItem (activity) ──────────────────────────────────────────────────── */
const KIND_ICON: Record<string, ReactNode> = {
  TASK_POSTED: <Zap size={13} />,
  BID_PLACED: <Gavel size={13} />,
  TASK_ASSIGNED: <Bot size={13} />,
  TASK_SETTLED: <CheckCircle2 size={13} />,
  AGENT_REGISTERED: <Bot size={13} />,
  AGENT_SLASHED: <Coins size={13} />,
};
const KIND_COLOR: Record<string, string> = {
  TASK_POSTED: "text-blue-l border-blue/30",
  BID_PLACED: "text-violet border-purple/30",
  TASK_ASSIGNED: "text-violet border-purple/30",
  TASK_SETTLED: "text-green border-green/30",
  AGENT_REGISTERED: "text-blue-l border-blue/30",
  AGENT_SLASHED: "text-red border-red/30",
};

export function FeedItem({ ev }: { ev: ActivityEvent }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span
        className={cn(
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border bg-deep",
          KIND_COLOR[ev.kind] ?? "text-grey-l border-border2",
        )}
      >
        {KIND_ICON[ev.kind] ?? <Zap size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-white">{ev.title}</div>
        <div className="mono mt-0.5 flex items-center gap-2 text-[10px] text-grey">
          <span>{timeAgo(ev.atMs)}</span>
          {ev.wallet && <span>· {shortAddr(ev.wallet)}</span>}
          {ev.amountUsdc != null && <span className="text-usdc-l">· ${ev.amountUsdc.toFixed(2)}</span>}
        </div>
      </div>
    </div>
  );
}
