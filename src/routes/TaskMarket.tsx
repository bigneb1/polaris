import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Inbox, Plus, Search } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { FeedItem, RowList, TaskItem } from "../components/ui/cards";
import { EmptyState, ErrorNotice, Skeleton, StatusBadge, USDCAmount } from "../components/ui/primitives";
import { useActivity, useMarketStats, useRecurringPlans, useTasks } from "../lib/onchain";
import { coreDeployed } from "../lib/contracts";
import type { TaskStatus } from "../lib/types";
import { fmtDate } from "../lib/utils";
import { useNetwork } from "../context/NetworkProvider";
import { useAsset } from "../hooks/useAsset";

type Filter = TaskStatus | "ALL" | "RECURRING";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "ASSIGNED", label: "In progress" },
  { key: "SETTLED", label: "Completed" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "RECURRING", label: "Recurring" },
];

/**
 * The market floor: every task on the active network, plus the live settlement feed.
 *
 * Search and filters live in the toolbar and the aggregates live in the details panel,
 * so the scrolling area is nothing but the list itself.
 */
export default function TaskMarket() {
  const navigate = useNavigate();
  const { network } = useNetwork();
  const { symbol } = useAsset();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const { tasks, isLoading, error } = useTasks();
  const { plans } = useRecurringPlans();
  const { stats } = useMarketStats();
  const { activity, error: activityError } = useActivity();

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: tasks.length, RECURRING: plans.length };
    for (const f of FILTERS) {
      if (f.key !== "ALL" && f.key !== "RECURRING") c[f.key] = tasks.filter((t) => t.status === f.key).length;
    }
    return c;
  }, [tasks, plans]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => (filter === "ALL" || filter === "RECURRING" ? true : t.status === filter))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.ref.toLowerCase().includes(q));
  }, [tasks, filter, search]);

  return (
    <AppShell
      toolbar={
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-56">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tasks…"
                className="field h-7 w-full pl-7"
              />
            </div>
            <button onClick={() => navigate("/create-task")} className="tool-btn-primary sm:hidden">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="hidden sm:block w-px h-4 bg-border" />
          <div className="flex items-center gap-0.5 overflow-x-auto sm:flex-1 -mx-1 px-1 sm:mx-0 sm:px-0">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                data-active={filter === f.key}
                onClick={() => setFilter(f.key)}
                className="tool-btn"
              >
                {f.label}
                {counts[f.key] != null && <span className="text-muted-foreground">{counts[f.key]}</span>}
              </button>
            ))}
          </div>
          <button onClick={() => navigate("/create-task")} className="tool-btn-primary hidden sm:inline-flex">
            <Plus className="h-3.5 w-3.5" /> New task
          </button>
        </div>
      }
      panel={
        <>
          <PanelSection title="Market">
            <PanelRow label="Open tasks" value={stats.openTasks} />
            <PanelRow label={`${symbol} in escrow`} value={<USDCAmount amount={stats.escrowUsdc} />} />
            <PanelRow label="Active agents" value={stats.activeAgents} />
            <PanelRow label="Settled today" value={stats.settledToday} />
            <PanelRow label={`Total settled`} value={<USDCAmount amount={stats.totalSettledUsdc} />} />
          </PanelSection>
          <PanelSection title="Network">
            <PanelRow label="Chain" value={network.label} />
            <PanelRow label="Chain id" value={network.chainId} mono />
            <PanelRow label="Settles in" value={symbol} />
            <PanelRow label="Explorer" value={network.explorerName} />
          </PanelSection>
          <PanelSection title="Activity" defaultOpen={false}>
            {activityError ? (
              <p className="text-[11px] text-destructive">Activity feed unavailable.</p>
            ) : activity.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">Nothing yet on this network.</p>
            ) : (
              <div className="-mx-3">
                {activity.slice(0, 12).map((ev, i) => (
                  <FeedItem key={ev.id} ev={ev} first={i === 0} />
                ))}
              </div>
            )}
          </PanelSection>
        </>
      }
    >
      <div className="max-w-4xl mx-auto p-4">
        {!coreDeployed(network.id) ? (
          <ErrorNotice message={`Polaris is not deployed on ${network.label} yet, so there is no market to show.`} />
        ) : error ? (
          <ErrorNotice message="Could not load the market. Check your connection and try again." />
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : filter === "RECURRING" ? (
          plans.length === 0 ? (
            <EmptyState
              title="No recurring plans"
              message={`Nobody has posted a recurring plan on ${network.label} yet.`}
              action={
                <Link to="/subscriptions" className="tool-btn-primary">
                  Post a recurring plan
                </Link>
              }
            />
          ) : (
            <RowList>
              {plans.map((p, i) => (
                <Link
                  key={p.planId}
                  to={`/plan/${p.planId}`}
                  className={`flex items-center gap-2 sm:gap-4 px-3 py-2.5 bg-card transition-colors hover:bg-muted/60 ${i !== 0 ? "border-t border-border" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">{p.title}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {p.schedule} · {p.done}/{p.total} delivered · from {fmtDate(p.createdAtMs)}
                    </p>
                  </div>
                  <USDCAmount amount={p.perDeliveryUsdc} size="sm" className="shrink-0" />
                  <div className="shrink-0 hidden xs:block">
                    <StatusBadge status={p.status} />
                  </div>
                </Link>
              ))}
            </RowList>
          )
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-7 w-7" />}
            title={tasks.length === 0 ? `No tasks on ${network.label}` : "No tasks match those filters"}
            message={
              tasks.length === 0
                ? "Post the first one and the agent swarm will bid on it."
                : "Try a different filter or clear the search."
            }
            action={
              tasks.length === 0 ? (
                <Link to="/create-task" className="tool-btn-primary">
                  <Plus className="h-3.5 w-3.5" /> Create the first task
                </Link>
              ) : undefined
            }
          />
        ) : (
          <RowList>
            {filtered.map((t, i) => (
              <TaskItem key={t.taskId} task={t} first={i === 0} />
            ))}
          </RowList>
        )}
      </div>
    </AppShell>
  );
}
