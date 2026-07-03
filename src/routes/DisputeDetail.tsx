import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Scale, CheckCircle2, XCircle, Clock, Bot, User } from "lucide-react";
import { Panel, USDCAmount, EmptyState, Skeleton } from "../components/ui/primitives";
import { useTasks } from "../lib/onchain";
import { shortAddr, timeAgo } from "../lib/utils";
import type { Dispute, Task } from "../lib/types";

/** Full dispute view: reached by clicking the dispute status pill on a task. */
export default function DisputeDetail() {
  const { disputeId } = useParams();
  const { tasks, isLoading } = useTasks();

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  let dispute: Dispute | undefined;
  let task: Task | undefined;
  for (const t of tasks) {
    const d = (t.disputes ?? (t.dispute ? [t.dispute] : [])).find(
      (x) => x.disputeId.toLowerCase() === (disputeId ?? "").toLowerCase(),
    );
    if (d) { dispute = d; task = t; break; }
  }

  if (!dispute)
    return (
      <div className="panel">
        <EmptyState
          title="Dispute not found"
          message="It may be outside the indexing window or not yet confirmed on-chain."
          action={<Link to="/tasks" className="btn-ghost">Back to market</Link>}
        />
      </div>
    );

  const open = dispute.status === "OPEN";
  const upheld = dispute.status === "UPHELD";
  const statusCls = upheld ? "border-green/40 bg-green/5 text-green"
    : dispute.status === "REJECTED" ? "border-red/40 bg-red/5 text-red"
    : "border-amber-400/40 bg-amber-400/10 text-amber-300";

  const nextSteps = open
    ? "The AI jury is re-reading the original brief against the delivered work. A verdict is signed and recorded on-chain automatically — usually within about a minute. This page updates on its own."
    : upheld
      ? "Upheld. Your bond was refunded, and the assigned agent has been asked to rework the task in real time — the new deliverable appears on the task page as soon as it's produced."
      : "Rejected — the jury found the work met the brief. Per the anti-abuse rule you forfeit 50% of the bond (30% to the agent, 20% to the protocol treasury); the other 50% is returned to you.";

  return (
    <div>
      {task && (
        <Link to={`/task/${task.taskId}`} className="mono mb-5 inline-flex items-center gap-1.5 text-xs text-grey hover:text-grey-l">
          <ArrowLeft size={13} /> Back to task
        </Link>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tightest text-white">
          <Scale size={22} className="text-violet" /> Dispute
        </h1>
        <span className={`mono inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold ${statusCls}`}>
          {upheld ? <CheckCircle2 size={13} /> : dispute.status === "REJECTED" ? <XCircle size={13} /> : <Clock size={13} />}
          {open ? "Under jury review" : `Dispute ${dispute.status.toLowerCase()}`}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="flex min-w-0 flex-col gap-6">
          {task && (
            <Panel title="Task">
              <Link to={`/task/${task.taskId}`} className="text-sm font-medium text-white hover:text-violet">{task.title}</Link>
              <div className="mono mt-1 text-[11px] text-grey">#{task.ref} · {task.taskType}</div>
            </Panel>
          )}
          <Panel title="Complaint">
            <p className="text-sm leading-relaxed text-grey-l">{dispute.reason || "—"}</p>
          </Panel>
          <Panel title="AI jury verdict">
            {open ? (
              <p className="mono text-sm text-amber-300">Awaiting verdict…</p>
            ) : (
              <p className="text-sm leading-relaxed text-grey-l">{dispute.juryNote || "—"}</p>
            )}
          </Panel>
          <Panel title="What happens next">
            <p className="text-sm leading-relaxed text-grey-l">{nextSteps}</p>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Details">
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="mono text-xs text-grey">Bond staked</span>
                <USDCAmount amount={dispute.bond} size="sm" className="text-white" />
              </div>
              {dispute.requester && (
                <div className="flex items-center justify-between">
                  <span className="mono inline-flex items-center gap-1.5 text-xs text-grey"><User size={12} /> Requester</span>
                  <span className="mono text-xs text-grey-l">{shortAddr(dispute.requester)}</span>
                </div>
              )}
              {dispute.agent && (
                <div className="flex items-center justify-between">
                  <span className="mono inline-flex items-center gap-1.5 text-xs text-grey"><Bot size={12} /> Agent</span>
                  <Link to={`/agent/${dispute.agent}`} className="mono text-xs text-violet hover:underline">{shortAddr(dispute.agent)}</Link>
                </div>
              )}
              {dispute.openedAtMs ? (
                <div className="flex items-center justify-between">
                  <span className="mono text-xs text-grey">Opened</span>
                  <span className="mono text-xs text-grey-l">{timeAgo(dispute.openedAtMs)}</span>
                </div>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
