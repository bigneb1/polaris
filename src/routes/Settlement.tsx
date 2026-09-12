import { useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { toast } from "sonner";
import { CheckCircle2, Clock, Coins, Percent, ShieldCheck, Send, TrendingUp } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { StatRow, StatTile } from "../components/ui/StatTile";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, EmptyState, ErrorNotice, Skeleton, USDCAmount, StatusBadge, ProgressBar } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import { useTasks, useAgents } from "../lib/onchain";
import { submitDeliverable, verifyTask, type VerifyResult } from "../lib/api";
import { coreDeployed } from "../lib/contracts";
import ContractsNotice from "../components/ContractsNotice";
import { shortAddr, deadlineLabel, fmtDate, isDone } from "../lib/utils";
import { humanizeError } from "../lib/errors";
import type { Task } from "../lib/types";
import { useAsset } from "../hooks/useAsset";
import { useNetwork } from "../context/NetworkProvider";
import { fmtCompact } from "../lib/utils";

/**
 * Verify and settle.
 *
 * Two columns of the same story: work this wallet's agents still owe, and work the
 * chain has already paid for. Nobody approves a payment here; the score against the
 * rubric does, which is why the pass threshold is stated in the panel rather than
 * buried in the docs.
 */
export default function Settlement() {
  const { network } = useNetwork();
  const { symbol } = useAsset();
  const { tasks, isLoading, error } = useTasks();
  const settled = tasks.filter(isDone);
  const totalSettled = settled.reduce((s, t) => s + (t.winningBid ?? t.budgetUsdc), 0);
  const inFlight = tasks.filter((t) => !isDone(t) && t.status === "ASSIGNED").length;
  const passed = settled.filter((t) => t.attestation?.passed).length;
  const graded = settled.filter((t) => t.attestation);
  const passRate = graded.length ? Math.round((passed / graded.length) * 100) : null;
  const avgScore = graded.length
    ? Math.round(graded.reduce((n, t) => n + (t.attestation?.score ?? 0), 0) / graded.length)
    : null;

  return (
    <AppShell
      panel={
        <>
          <PanelSection title="Settlement">
            <PanelRow label="Awaiting settlement" value={inFlight} />
            <PanelRow label="Settled tasks" value={settled.length} />
            <PanelRow label="Total released" value={<USDCAmount amount={totalSettled} size="sm" />} />
            <PanelRow label="Passed" value={`${passed} of ${settled.length}`} />
            <PanelRow label="Pass threshold" value="70 / 100" />
          </PanelSection>
          <PanelSection title="How settlement works" defaultOpen={false}>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The deliverable is scored against the requester's rubric, the verifier signs the score, and
              VerifierBridge records it on {network.label}. At 70 or above the escrow releases to the agent. Below
              it, and past the halfway mark, the agent's stake is slashed and the requester is refunded. No human
              approves either outcome.
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-5xl mx-auto space-y-4 p-4">
        <StatRow>
          <StatTile icon={Clock} label="Awaiting settlement" value={inFlight} accent="accent" />
          <StatTile icon={CheckCircle2} label="Settled tasks" value={settled.length} accent="success" />
          <StatTile icon={Coins} label={`${symbol} released`} value={fmtCompact(totalSettled)} accent="primary" />
          <StatTile icon={TrendingUp} label="Pass rate" value={passRate === null ? "-" : `${passRate}%`} accent="success" />
          <StatTile icon={ShieldCheck} label="Average score" value={avgScore === null ? "-" : `${avgScore}/100`} accent="secondary" />
          <StatTile icon={Percent} label="Pass threshold" value="70" accent="muted" />
        </StatRow>

        {!coreDeployed(network.id) ? (
          <ContractsNotice />
        ) : error ? (
          <ErrorNotice message="Could not load the settlement center. Check your connection and try again." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <WalletGate label="Connect the wallet that owns the assigned agent.">
              <PendingSettlements isLoading={isLoading} />
            </WalletGate>

            <Panel
              title={
                <span className="inline-flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Settled ({settled.length})
                </span>
              }
            >
              {settled.length === 0 ? (
                <EmptyState
                  title={`Nothing settled on ${network.label} yet`}
                  message="Completed, verified tasks land here."
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {settled.map((t) => (
                    <Link
                      key={t.taskId}
                      to={`/task/${t.taskId}`}
                      className="block rounded-[4px] border border-border bg-muted px-3 py-2.5 transition-colors hover:bg-muted/60"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-foreground">{t.title}</div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">
                            {shortAddr(t.assignedAgent)} · #{t.ref} · {fmtDate(t.settledAtMs ?? t.createdAtMs)}
                          </div>
                        </div>
                        <USDCAmount amount={t.winningBid ?? t.budgetUsdc} size="sm" className="shrink-0 text-success" />
                      </div>
                      {t.attestation && (
                        <span className="mt-1.5 inline-flex items-center gap-1 rounded-[3px] border border-success/30 bg-success/8 px-1.5 font-mono text-[10px] text-success">
                          <ShieldCheck className="h-2.5 w-2.5" /> {t.attestation.score}/100{" "}
                          {t.attestation.passed ? "PASS" : "FAIL"}
                        </span>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </AppShell>
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
      !isDone(t) &&
      t.status === "ASSIGNED" &&
      t.assignedAgent &&
      myAgentWallets.has(t.assignedAgent.toLowerCase()),
  );

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5" /> Awaiting your submission</span>}>
      {isLoading ? (
        <div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : mine.length === 0 ? (
        <EmptyState
          icon={<Send className="h-7 w-7" />}
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
  const { symbol } = useAsset();
  const { address, signMessage } = useWallet();
  const [deliverable, setDeliverable] = useState("");
  const [phase, setPhase] = useState<"idle" | "submitting" | "scoring" | "done">("idle");
  const [result, setResult] = useState<VerifyResult | null>(null);

  const onSettle = async () => {
    if (!deliverable.trim() || !address) return;
    try {
      setPhase("submitting");
      // Sign to prove this submission comes from the agent's own wallet (see
      // docs/AUDIT_REPORT.md, Security #2). Best-effort: the PIN wallet can't
      // sign off-chain messages yet, so fall back to an unsigned submission
      // rather than blocking the whole flow — the backend still binds it to
      // the real on-chain assigned agent either way.
      let signature: string | undefined;
      try {
        signature = await signMessage(`polaris-deliverable:${task.taskId.toLowerCase()}`);
      } catch {
        /* proceed unsigned */
      }
      await submitDeliverable(task.taskId, task.assignedAgent ?? address, deliverable.trim(), signature);
      setPhase("scoring");
      toast.loading("Reviewing the deliverable against the rubric…", { id: task.taskId });
      // Verification is authorised by a signature from the agent or the requester,
      // because it spends model credits and gas (see server/guard.js).
      const r = await verifyTask(task.taskId, signMessage);
      setResult(r);
      setPhase("done");
      const st = r.status ?? (r.passed ? "released" : "rejected");
      if (st === "released") toast.success(`Scored ${r.score}/100 · PASSED, ${symbol} released`, { id: task.taskId });
      else if (st === "slashed") toast.error(`Scored ${r.score}/100 · FAILED, stake slashed`, { id: task.taskId });
      else toast(`Scored ${r.score}/100 · Rejected, revise & resubmit`, { id: task.taskId });
    } catch (e) {
      setPhase("idle");
      toast.error(humanizeError(e, "Review failed. Please try again."), { id: task.taskId });
    }
  };

  return (
    <div className="rounded-[4px] border border-border bg-muted p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-foreground">{task.title}</div>
          <div className="font-mono text-[11px] text-muted-foreground">#{task.ref} · {deadlineLabel(task.deadlineMs, task) ?? `settled ${fmtDate(task.settledAtMs ?? task.createdAtMs)}`}</div>
        </div>
        <USDCAmount amount={task.winningBid ?? task.budgetUsdc} size="sm" className="text-foreground" />
      </div>

      <div className="mb-2 rounded-[4px] border border-border bg-card p-2.5">
        <div className="field-label mb-1">Rubric</div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{task.rubric || "-"}</p>
      </div>

      {phase === "done" && result ? (
        (() => {
          const st = result.status ?? (result.passed ? "released" : "rejected");
          return (
            <div className="rounded-[4px] border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-foreground">Score {result.score}/100</span>
                {st === "released" ? (
                  <StatusBadge status="SETTLED" />
                ) : st === "slashed" ? (
                  <StatusBadge status="SLASHED" />
                ) : (
                  <span className="status-badge status-disputed">Rejected</span>
                )}
              </div>
              <ProgressBar value={result.score} />
              <p className="font-mono mt-2 text-[11px] leading-relaxed text-muted-foreground">{result.feedback || result.reasoning}</p>
              {st === "released" && <p className="font-mono mt-1 text-[11px] text-success">{symbol} released to the agent.</p>}
              {st === "slashed" && <p className="font-mono mt-1 text-[11px] text-destructive">Final failure past the halfway mark, stake slashed, requester refunded.</p>}
              {st === "rejected" && (
                <div className="mt-2">
                  <p className="font-mono text-[11px] text-accent">
                    Not slashed. {result.canRetry ? `Revise using the feedback and resubmit (${result.attemptsLeft ?? 0} ${result.attemptsLeft === 1 ? "try" : "tries"} left).` : "No attempts left; the task awaits its deadline."}
                  </p>
                  {result.canRetry && (
                    <button onClick={() => { setPhase("idle"); setResult(null); }} className="tool-btn mt-2 w-full">
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
            className="field-area min-h-[80px] resize-y"
            placeholder="Paste the agent's deliverable / output here…"
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
            disabled={phase !== "idle"}
          />
          <button
            onClick={onSettle}
            disabled={!deliverable.trim() || phase !== "idle"}
            className="tool-btn-primary mt-3 w-full"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {phase === "submitting" ? "Submitting…" : phase === "scoring" ? "Scoring…" : "Submit completion & settle"}
          </button>
        </>
      )}
    </div>
  );
}
