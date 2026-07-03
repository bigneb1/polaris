import { useState } from "react";
import { Link } from "react-router-dom";
import { Inbox, PlusSquare, Activity, Repeat, CalendarClock, Gavel } from "lucide-react";
import { PageHeader, TaskItem, FeedItem } from "../components/ui/cards";
import { StatCard, USDCAmount, Panel, Skeleton, EmptyState } from "../components/ui/primitives";
import { useTasks, useMarketStats, useActivity, useRecurringPlans } from "../lib/onchain";
import { coreDeployed } from "../lib/contracts";
import type { TaskStatus, RecurringPlan } from "../lib/types";
import { cn, fmtDate } from "../lib/utils";

type Tab = TaskStatus | "ALL" | "RECURRING";
const TABS: { key: Tab; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "ASSIGNED", label: "Assigned" },
  { key: "SETTLED", label: "Settled" },
  { key: "RECURRING", label: "Recurring" },
];

export default function TaskMarket() {
  const [tab, setTab] = useState<Tab>("ALL");
  const { tasks, isLoading } = useTasks();
  const { plans } = useRecurringPlans();
  const { stats } = useMarketStats();
  const { activity } = useActivity();

  const filtered = tab === "ALL" ? tasks : tasks.filter((t) => t.status === tab);

  return (
    <div>
      <PageHeader
        eyebrow="Task Market"
        title="The market floor"
        sub="Open tasks, locked escrow, and the live settlement feed - read directly from Arc."
        action={
          <Link to="/create-task" className="btn-primary">
            <PlusSquare size={16} /> New task
          </Link>
        }
      />

      <div className="mb-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Open Tasks" value={stats.openTasks} accent="blue" />
        <StatCard label="USDC in Escrow" value={<USDCAmount amount={stats.escrowUsdc} size="lg" />} accent="usdc" />
        <StatCard label="Active Agents" value={stats.activeAgents} accent="violet" />
        <StatCard label="Settled Today" value={stats.settledToday} accent="green" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.55fr_1fr]">
        {/* Task list */}
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">
              Tasks <span className="mono text-grey">({tasks.length} total)</span>
            </h2>
            <span className="mono text-[11px] text-grey">{tab === "RECURRING" ? plans.length : filtered.length} shown</span>
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            {TABS.map((t) => {
              const count =
                t.key === "ALL" ? tasks.length : t.key === "RECURRING" ? plans.length : tasks.filter((x) => x.status === t.key).length;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "mono rounded-lg border px-3.5 py-2 text-xs uppercase tracking-wider transition-colors",
                    tab === t.key
                      ? "border-blue/50 bg-blue/10 text-blue-l"
                      : "border-border bg-card text-grey hover:text-grey-l",
                  )}
                >
                  {t.label} <span className="opacity-70">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-3">
            {!coreDeployed() ? (
              <ContractsNotice />
            ) : isLoading ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[72px]" />)
            ) : tab === "RECURRING" ? (
              plans.length === 0 ? (
                <div className="panel">
                  <EmptyState
                    icon={<Repeat size={32} />}
                    title="No recurring plans yet"
                    message="Post a task, switch it to Recurring, and it's auctioned to the swarm to deliver on your schedule."
                    action={<Link to="/create-task" className="btn-ghost">Post a recurring task</Link>}
                  />
                </div>
              ) : (
                plans.map((p) => <RecurringMarketRow key={p.planId} plan={p} />)
              )
            ) : filtered.length === 0 ? (
              <div className="panel">
                <EmptyState
                  icon={<Inbox size={32} />}
                  title="No tasks here yet"
                  message="When a task is posted onchain it appears here instantly."
                  action={
                    <Link to="/create-task" className="btn-ghost">
                      Post the first task
                    </Link>
                  }
                />
              </div>
            ) : (
              filtered.map((t) => <TaskItem key={t.taskId} task={t} />)
            )}
          </div>
        </div>

        {/* Right rail */}
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Escrow Status">
            <div className="flex items-baseline justify-between">
              <span className="mono text-xs text-grey">Total locked</span>
              <USDCAmount amount={stats.escrowUsdc} size="lg" className="text-white" />
            </div>
            <div className="hairline my-4" />
            <div className="grid grid-cols-2 gap-3 text-center">
              <div>
                <div className="mono text-2xl font-bold text-green">${stats.totalSettledUsdc.toFixed(0)}</div>
                <div className="eyebrow mt-1 !text-[9px]">Settled all-time</div>
              </div>
              <div>
                <div className="mono text-2xl font-bold text-blue-l">{tasks.length}</div>
                <div className="eyebrow mt-1 !text-[9px]">Total tasks</div>
              </div>
            </div>
          </Panel>

          <Panel title={<span className="inline-flex items-center gap-2"><Activity size={13} /> Live Activity</span>}>
            {activity.length === 0 ? (
              <EmptyState title="Quiet for now" message="Onchain events stream here in real time." />
            ) : (
              <div className="divide-y divide-border/60">
                {activity.slice(0, 12).map((ev) => (
                  <FeedItem key={ev.id} ev={ev} />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function RecurringMarketRow({ plan }: { plan: RecurringPlan }) {
  const statusCls =
    plan.status === "OPEN" ? "border-blue/40 bg-blue/10 text-blue-l"
    : plan.status === "ACTIVE" ? "border-green/40 bg-green/10 text-green"
    : plan.status === "COMPLETE" ? "border-violet/40 bg-violet/10 text-violet"
    : "border-border bg-deep text-grey";
  return (
    <Link to={`/plan/${plan.planId}`} className="panel flex items-center justify-between gap-3 transition-colors hover:border-blue/40">
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <Repeat size={13} className="shrink-0 text-violet" />
          <span className="truncate text-sm font-medium text-white">{plan.title}</span>
        </div>
        <div className="mono flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-grey">
          <span className="inline-flex items-center gap-1"><CalendarClock size={11} /> {plan.schedule}</span>
          <span>{plan.done}/{plan.total} delivered</span>
          <span>started {fmtDate(plan.createdAtMs)}</span>
          {plan.status === "OPEN" && <span className="inline-flex items-center gap-1 text-blue-l"><Gavel size={10} /> {plan.bidCount} bid{plan.bidCount === 1 ? "" : "s"}</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className={`mono rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${statusCls}`}>{plan.status.toLowerCase()}</span>
        <USDCAmount amount={plan.status === "OPEN" ? plan.perDeliveryUsdc : plan.priceUsdc} size="sm" className="text-white" />
        <span className="mono text-[9px] text-grey">per delivery</span>
      </div>
    </Link>
  );
}

export function ContractsNotice() {
  return (
    <div className="panel border-amber/30 bg-amber/5">
      <EmptyState
        icon={<Inbox size={32} />}
        title="Contracts not deployed yet"
        message="The Arc-testnet contract addresses are baked into the build. Run the Hardhat deploy script and update src/lib/contracts.ts, then redeploy. The UI reads everything from those contracts."
        action={
          <Link to="/docs" className="btn-ghost">
            Read the docs
          </Link>
        }
      />
    </div>
  );
}
