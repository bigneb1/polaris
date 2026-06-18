import { useState } from "react";
import { Link } from "react-router-dom";
import { Inbox, PlusSquare, Activity } from "lucide-react";
import { PageHeader, TaskItem, FeedItem } from "../components/ui/cards";
import { StatCard, USDCAmount, Panel, Skeleton, EmptyState } from "../components/ui/primitives";
import { useTasks, useMarketStats, useActivity } from "../lib/onchain";
import { coreDeployed } from "../lib/contracts";
import type { TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";

const TABS: { key: TaskStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "ASSIGNED", label: "Assigned" },
  { key: "SETTLED", label: "Settled" },
];

export default function TaskMarket() {
  const [tab, setTab] = useState<TaskStatus | "ALL">("ALL");
  const { tasks, isLoading } = useTasks();
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
          <div className="mb-4 flex flex-wrap gap-2">
            {TABS.map((t) => (
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
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {!coreDeployed() ? (
              <ContractsNotice />
            ) : isLoading ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[72px]" />)
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

export function ContractsNotice() {
  return (
    <div className="panel border-amber/30 bg-amber/5">
      <EmptyState
        icon={<Inbox size={32} />}
        title="Contracts not deployed yet"
        message="Set the VITE_CONTRACT_* addresses in your env after running the Hardhat deploy script to Arc Testnet. The UI reads everything from those contracts."
        action={
          <Link to="/docs" className="btn-ghost">
            Read the docs
          </Link>
        }
      />
    </div>
  );
}
