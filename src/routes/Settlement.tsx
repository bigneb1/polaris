import { useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { toast } from "sonner";
import { CheckCircle2, ShieldCheck, Send } from "lucide-react";
import { PageHeader } from "../components/ui/cards";
import { StatCard, Panel, EmptyState, Skeleton, USDCAmount, StatusBadge, ProgressBar } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import { useTasks, useAgents } from "../lib/onchain";
import { submitDeliverable, verifyTask, type VerifyResult } from "../lib/api";
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
                  <Link
                    key={t.taskId}
                    to={`/task/${t.taskId}`}
                    className="block rounded-xl border border-border bg-deep px-4 py-3 transition-colors hover:border-blue"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">{t.title}</div>
                        <div className="mono truncate text-[11px] text-grey">
                          {shortAddr(t.assignedAgent)} · #{t.ref}
                        </div>
                      </div>
                      <USDCAmount amount={t.winningBid ?? t.budgetUsdc} size="sm" className="shrink-0 text-green" />
                    </div>
                    {t.attestation && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="mono inline-flex shrink-0 items-center gap-1 rounded-md border border-green/30 bg-green/5 px-1.5 py-0.5 text-[10px] text-green">
                          <ShieldCheck size={11} /> {t.attestation.score}/100 {t.attestation.passed ? "PASS" : "FAIL"}
                        </span>
                        <span className="mono text-[10px] text-grey">click for details</span>
                      </div>
                    )}
                  </Link>
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
  const [result, setResult] = useState<VerifyResult | null>(null);

  const onSettle = async () => {
    if (!deliverable.trim() || !address) return;
    try {
      setPhase("submitting");
      await submitDeliverable(task.taskId, task.assignedAgent ?? address, deliverable.trim());
      setPhase("scoring");
      toast.loading("Reviewing the deliverable against the rubric…", { id: task.taskId });
      const r = await verifyTask(task.taskId);
      setResult(r);
      setPhase("done");
      const st = r.status ?? (r.passed ? "released" : "rejected");
      if (st === "released") toast.success(`Scored ${r.score}/100 · PASSED — USDC released`, { id: task.taskId });
      else if (st === "slashed") toast.error(`Scored ${r.score}/100 · FAILED — stake slashed`, { id: task.taskId });
      else toast(`Scored ${r.score}/100 · Rejected — revise & resubmit`, { id: task.taskId });
    } catch (e) {
      setPhase("idle");
      toast.error(humanizeError(e, "Review failed. Please try again."), { id: task.taskId });
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
        (() => {
          const st = result.status ?? (result.passed ? "released" : "rejected");
          return (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="mono text-sm text-white">Score {result.score}/100</span>
                {st === "released" ? (
                  <StatusBadge status="SETTLED" />
                ) : st === "slashed" ? (
                  <StatusBadge status="SLASHED" />
                ) : (
                  <span className="mono rounded-md border border-amber/40 bg-amber/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber">
                    Rejected
                  </span>
                )}
              </div>
              <ProgressBar value={result.score} />
              <p className="mono mt-2 text-[11px] leading-relaxed text-grey-l">{result.feedback || result.reasoning}</p>
              {st === "released" && <p className="mono mt-1 text-[11px] text-green">USDC released to the agent.</p>}
              {st === "slashed" && <p className="mono mt-1 text-[11px] text-red">Final failure past the halfway mark — stake slashed, requester refunded.</p>}
              {st === "rejected" && (
                <div className="mt-2">
                  <p className="mono text-[11px] text-amber">
                    Not slashed. {result.canRetry ? `Revise using the feedback and resubmit (${result.attemptsLeft ?? 0} ${result.attemptsLeft === 1 ? "try" : "tries"} left).` : "No attempts left; the task awaits its deadline."}
                  </p>
                  {result.canRetry && (
                    <button onClick={() => { setPhase("idle"); setResult(null); }} className="btn-ghost mt-2 !py-2 w-full">
                      Revise & resubmit
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()
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
