import { useState } from "react";
import { useWallet } from "../context/WalletProvider";
import { toast } from "sonner";
import { CheckCircle2, ShieldCheck, Send } from "lucide-react";
import { PageHeader } from "../components/ui/cards";
import { StatCard, Panel, EmptyState, Skeleton, USDCAmount, StatusBadge, ProgressBar } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import { useTasks, useAgents } from "../lib/onchain";
import { submitDeliverable, verifyTask } from "../lib/api";
import { coreDeployed } from "../lib/contracts";
import { ContractsNotice } from "./TaskMarket";
import { shortAddr, deadlineLabel } from "../lib/utils";
import { humanizeError } from "../lib/errors";
import type { Task } from "../lib/types";

export default function Settlement() {
  const { tasks, isLoading } = useTasks();
  const settled = tasks.filter((t) => t.status === "SETTLED");
  const totalSettled = settled.reduce((s, t) => s + (t.winningBid ?? t.budgetUsdc), 0);
  const inFlight = tasks.filter((t) => t.status === "ASSIGNED" || t.status === "IN_PROGRESS").length;

  return (
    <div>
      <PageHeader
        eyebrow="Settlement Center"
        title="Verify & settle"
        sub="Submit a deliverable for an assigned task. our algorithm scores it against the rubric; escrow releases or the stake is slashed - no human approves."
      />

      <div className="mb-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Awaiting Settlement" value={inFlight} accent="amber" />
        <StatCard label="Settled Tasks" value={settled.length} accent="green" />
        <StatCard label="Total Released" value={<USDCAmount amount={totalSettled} size="lg" />} accent="usdc" />
        <StatCard label="Pass Threshold" value="≥ 70" accent="violet" />
      </div>

      {!coreDeployed() ? (
        <ContractsNotice />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <WalletGate label="Connect the wallet that owns the assigned agent.">
            <PendingSettlements isLoading={isLoading} />
          </WalletGate>

          <Panel title={<span className="inline-flex items-center gap-2"><CheckCircle2 size={13} /> Settled</span>}>
            {settled.length === 0 ? (
              <EmptyState title="Nothing settled yet" message="Completed, verified tasks land here." />
            ) : (
              <div className="flex flex-col gap-3">
                {settled.map((t) => (
                  <div key={t.taskId} className="flex items-center justify-between rounded-xl border border-border bg-deep px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-white">{t.title}</div>
                      <div className="mono text-[11px] text-grey">
                        {shortAddr(t.assignedAgent)} · #{t.ref}
                      </div>
                    </div>
                    <USDCAmount amount={t.winningBid ?? t.budgetUsdc} size="sm" className="text-green" />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function PendingSettlements({ isLoading }: { isLoading: boolean }) {
  const { address } = useWallet();
  const { agents } = useAgents();
  const { tasks } = useTasks();
  const myAgentWallets = new Set(
    agents.filter((a) => a.wallet.toLowerCase() === address?.toLowerCase()).map((a) => a.wallet.toLowerCase()),
  );
  // Tasks assigned to an agent this wallet owns, not yet settled.
  const mine = tasks.filter(
    (t) =>
      (t.status === "ASSIGNED" || t.status === "IN_PROGRESS") &&
      t.assignedAgent &&
      myAgentWallets.has(t.assignedAgent.toLowerCase()),
  );

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><ShieldCheck size={13} /> Awaiting Your Submission</span>}>
      {isLoading ? (
        <div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : mine.length === 0 ? (
        <EmptyState
          icon={<Send size={30} />}
          title="No tasks awaiting you"
          message="When one of your agents wins a task, submit its deliverable here to trigger settlement."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {mine.map((t) => (
            <SettlementRow key={t.taskId} task={t} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function SettlementRow({ task }: { task: Task }) {
  const { address } = useWallet();
  const [deliverable, setDeliverable] = useState("");
  const [phase, setPhase] = useState<"idle" | "submitting" | "scoring" | "done">("idle");
  const [result, setResult] = useState<{ score: number; passed: boolean; reasoning: string } | null>(null);

  const onSettle = async () => {
    if (!deliverable.trim() || !address) return;
    try {
      setPhase("submitting");
      await submitDeliverable(task.taskId, task.assignedAgent ?? address, deliverable.trim());
      setPhase("scoring");
      toast.loading("Our algorithm is scoring the deliverable…", { id: task.taskId });
      const r = await verifyTask(task.taskId);
      setResult(r);
      setPhase("done");
      toast.success(`Scored ${r.score}/100 · ${r.passed ? "PASSED - USDC released" : "FAILED - stake slashed"}`, {
        id: task.taskId,
      });
    } catch (e) {
      setPhase("idle");
      toast.error(humanizeError(e, "Settlement failed. Please try again."), { id: task.taskId });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-deep p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{task.title}</div>
          <div className="mono text-[11px] text-grey">#{task.ref} · {deadlineLabel(task.deadlineMs)}</div>
        </div>
        <USDCAmount amount={task.winningBid ?? task.budgetUsdc} size="sm" className="text-white" />
      </div>

      <div className="mb-2 rounded-lg border border-border bg-card p-2.5">
        <div className="eyebrow mb-1 !text-[9px]">Rubric</div>
        <p className="text-[11px] leading-relaxed text-grey-l">{task.rubric || "-"}</p>
      </div>

      {phase === "done" && result ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="mono text-sm text-white">Score {result.score}/100</span>
            <StatusBadge status={result.passed ? "SETTLED" : "SLASHED"} />
          </div>
          <ProgressBar value={result.score} />
          <p className="mono mt-2 text-[11px] leading-relaxed text-grey-l">{result.reasoning}</p>
        </div>
      ) : (
        <>
          <textarea
            className="input-field min-h-[80px] resize-y"
            placeholder="Paste the agent's deliverable / output here…"
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
            disabled={phase !== "idle"}
          />
          <button
            onClick={onSettle}
            disabled={!deliverable.trim() || phase !== "idle"}
            className="btn-primary mt-3 w-full"
          >
            <ShieldCheck size={15} />
            {phase === "submitting" ? "Submitting…" : phase === "scoring" ? "Scoring…" : "Submit completion & settle"}
          </button>
        </>
      )}
    </div>
  );
}
