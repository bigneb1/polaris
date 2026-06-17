import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ExternalLink, ShieldCheck, Clock, FileCheck2 } from "lucide-react";
import { Panel, StatCard, USDCAmount, StatusBadge, ReputationBar, EmptyState, Skeleton } from "../components/ui/primitives";
import { PageHeader } from "../components/ui/cards";
import { PolarisMark } from "../components/brand/Logo";
import { useAgent } from "../lib/onchain";
import { explorerAddr } from "../lib/chain";
import { shortAddr, timeAgo, deadlineLabel } from "../lib/utils";

/**
 * Agent detail - identity + reputation, and the agent's full task history
 * (current + completed) with the onchain settlement attestation (score +
 * deliverable hash) for each finished task.
 */
export default function AgentDetail() {
  const { wallet } = useParams();
  const { agent, tasks, isLoading } = useAgent(wallet);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!agent)
    return (
      <div className="panel">
        <EmptyState
          title="Agent not found"
          message="It may be outside the indexing window or not registered."
          action={<Link to="/explorer" className="btn-ghost">Back to explorer</Link>}
        />
      </div>
    );

  const active = tasks.filter((t) => t.status === "ASSIGNED" || t.status === "IN_PROGRESS");
  const done = tasks.filter((t) => t.status === "SETTLED");

  return (
    <div>
      <Link to="/explorer" className="mono mb-5 inline-flex items-center gap-1.5 text-xs text-grey hover:text-grey-l">
        <ArrowLeft size={14} /> Back to explorer
      </Link>

      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        sub={
          <a href={explorerAddr(agent.wallet)} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1.5 text-blue-l hover:underline">
            {shortAddr(agent.wallet, 10, 8)} <ExternalLink size={12} />
          </a>
        }
        action={<StatusBadge status={agent.slashed ? "SLASHED" : agent.online ? "ONLINE" : "OFFLINE"} />}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Reputation" value={agent.reputation} accent="violet" />
        <StatCard label="Tasks Done" value={agent.tasksCompleted} accent="green" />
        <StatCard label="Stake" value={<USDCAmount amount={agent.stakeUsdc} size="lg" />} accent="usdc" />
        <StatCard label="Earned" value={<USDCAmount amount={agent.totalEarned} size="lg" />} accent="blue" />
      </div>

      <div className="mb-6 panel p-5">
        <div className="mb-2 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-border2 bg-deep"><PolarisMark size={22} /></div>
          <div className="flex-1"><ReputationBar rep={agent.reputation} /></div>
        </div>
        {agent.capabilities.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.capabilities.map((c) => (
              <span key={c} className="mono rounded-md border border-border bg-deep px-2 py-0.5 text-[10px] text-grey-l">{c}</span>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={<span className="inline-flex items-center gap-2"><Clock size={13} /> In Progress ({active.length})</span>}>
          {active.length === 0 ? (
            <EmptyState title="Nothing in progress" message="Active assignments appear here until settled." />
          ) : (
            <div className="flex flex-col gap-3">{active.map((t) => <TaskRow key={t.taskId} task={t} />)}</div>
          )}
        </Panel>

        <Panel title={<span className="inline-flex items-center gap-2"><FileCheck2 size={13} /> Completed ({done.length})</span>}>
          {done.length === 0 ? (
            <EmptyState title="No completed tasks yet" message="Settled work + onchain attestations appear here." />
          ) : (
            <div className="flex flex-col gap-3">{done.map((t) => <TaskRow key={t.taskId} task={t} attestation />)}</div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function TaskRow({ task, attestation }: { task: import("../lib/types").Task; attestation?: boolean }) {
  return (
    <Link to={`/task/${task.taskId}`} className="block rounded-xl border border-border bg-deep p-4 transition-colors hover:border-border2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">{task.title}</div>
          <div className="mono text-[11px] text-grey">#{task.ref} · {task.status === "SETTLED" ? timeAgo(task.createdAtMs) : deadlineLabel(task.deadlineMs)}</div>
        </div>
        <USDCAmount amount={task.winningBid ?? task.budgetUsdc} size="sm" className="text-white" />
      </div>
      {attestation && task.attestation && (
        <div className="mt-3 rounded-lg border border-green/30 bg-green/5 p-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="mono inline-flex items-center gap-1.5 text-[11px] text-green">
              <ShieldCheck size={12} /> Onchain attestation · {task.attestation.score}/100 {task.attestation.passed ? "PASS" : "FAIL"}
            </span>
          </div>
          <div className="mono break-all text-[10px] text-grey">deliverable {task.attestation.deliverableHash}</div>
        </div>
      )}
    </Link>
  );
}
