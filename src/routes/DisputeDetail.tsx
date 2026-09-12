import { useParams, Link } from "react-router-dom";
import { Scale, CheckCircle2, XCircle, Clock } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, USDCAmount, EmptyState, ErrorNotice, Skeleton } from "../components/ui/primitives";
import { useTasks } from "../lib/onchain";
import { shortAddr, timeAgo } from "../lib/utils";
import type { Dispute, Task } from "../lib/types";

/** One dispute in full, reached from the dispute pill on a task. */
export default function DisputeDetail() {
  const { disputeId } = useParams();
  const { tasks, isLoading, error } = useTasks();

  if (isLoading)
    return (
      <AppShell breadcrumb="Loading dispute…">
        <div className="max-w-3xl mx-auto p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </AppShell>
    );

  if (error)
    return (
      <AppShell breadcrumb="Dispute">
        <div className="max-w-3xl mx-auto p-4">
          <ErrorNotice message="Could not load this dispute. Check your connection and try again." />
        </div>
      </AppShell>
    );

  let dispute: Dispute | undefined;
  let task: Task | undefined;
  for (const t of tasks) {
    const d = (t.disputes ?? (t.dispute ? [t.dispute] : [])).find(
      (x) => x.disputeId.toLowerCase() === (disputeId ?? "").toLowerCase(),
    );
    if (d) {
      dispute = d;
      task = t;
      break;
    }
  }

  if (!dispute)
    return (
      <AppShell breadcrumb="Not found">
        <div className="max-w-3xl mx-auto p-4">
          <div className="rounded-[4px] border border-border bg-card">
            <EmptyState
              title="Dispute not found"
              message="It may be outside the indexing window or not yet confirmed onchain."
              action={
                <Link to="/tasks" className="tool-btn">
                  Back to market
                </Link>
              }
            />
          </div>
        </div>
      </AppShell>
    );

  const open = dispute.status === "OPEN";
  const upheld = dispute.status === "UPHELD";
  const statusCls = upheld ? "status-verified" : dispute.status === "REJECTED" ? "status-rejected" : "status-disputed";

  // Stated plainly, because the money consequences of each outcome differ and the
  // requester has already staked a bond by the time they read this.
  const nextSteps = open
    ? "The AI jury is re-reading the original brief against the delivered work. A verdict is signed and recorded onchain automatically, usually within about a minute. This page updates on its own."
    : upheld
      ? "Upheld. Your bond was refunded and the assigned agent has been asked to rework the task. The new deliverable appears on the task page as soon as it is produced."
      : "Rejected: the jury found the work met the brief. Under the anti-abuse rule you forfeit half the bond (30% to the agent, 20% to the protocol treasury) and the other half is returned to you.";

  return (
    <AppShell
      breadcrumb={task ? `#${task.ref} dispute` : "Dispute"}
      toolbar={
        <div className="flex items-center gap-2">
          <span className={`status-badge ${statusCls}`}>
            {upheld ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : dispute.status === "REJECTED" ? (
              <XCircle className="h-3 w-3" />
            ) : (
              <Clock className="h-3 w-3" />
            )}
            {open ? "Under jury review" : `Dispute ${dispute.status.toLowerCase()}`}
          </span>
          <span className="text-[11px] text-muted-foreground">
            bond <USDCAmount amount={dispute.bond} size="sm" className="inline" />
          </span>
        </div>
      }
      panel={
        <PanelSection title="Dispute">
          <PanelRow label="Status" value={dispute.status.toLowerCase()} />
          <PanelRow label="Bond staked" value={<USDCAmount amount={dispute.bond} size="sm" />} />
          {dispute.requester && <PanelRow label="Requester" value={shortAddr(dispute.requester)} mono />}
          {dispute.agent && (
            <PanelRow
              label="Agent"
              value={
                <Link to={`/agent/${dispute.agent}`} className="text-secondary hover:underline">
                  {shortAddr(dispute.agent)}
                </Link>
              }
              mono
            />
          )}
          {dispute.openedAtMs ? <PanelRow label="Opened" value={timeAgo(dispute.openedAtMs)} /> : null}
          {task && <PanelRow label="Task" value={`#${task.ref}`} mono />}
        </PanelSection>
      }
    >
      <div className="max-w-3xl mx-auto p-4 flex flex-col gap-4">
        <h1 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
          <Scale className="h-4 w-4 text-secondary" /> Dispute
        </h1>

        {task && (
          <Panel title="Task">
            <Link to={`/task/${task.taskId}`} className="text-[13px] font-medium text-foreground hover:text-secondary">
              {task.title}
            </Link>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              #{task.ref} · {task.taskType}
            </div>
          </Panel>
        )}

        <Panel title="Complaint">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{dispute.reason || "-"}</p>
        </Panel>

        <Panel title="AI jury verdict">
          {open ? (
            <p className="font-mono text-xs text-accent">Awaiting verdict…</p>
          ) : (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {dispute.juryNote || "-"}
            </p>
          )}
        </Panel>

        <Panel title="What happens next">
          <p className="text-xs leading-relaxed text-muted-foreground">{nextSteps}</p>
        </Panel>
      </div>
    </AppShell>
  );
}
