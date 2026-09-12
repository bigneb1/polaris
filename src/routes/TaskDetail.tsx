import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useParams, Link } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { ExternalLink, Gavel, Trophy, Bot, ShieldCheck, FileText, Lock, X, Scale, CheckCircle2, XCircle, Repeat, ArrowRight } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, USDCAmount, StatusBadge, EmptyState, ErrorNotice, Skeleton } from "../components/ui/primitives";
import { AgentAvatarImg } from "../components/AgentAvatar";
import DisputeModal from "../components/DisputeModal";
import { DeliverableView } from "../components/DeliverableView";
import type { Agent, Bid } from "../lib/types";
import { useTask, useAgents } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { placeBid, awardBid, cancelTask } from "../lib/tx";
import { getDeliverable, signDeliverableViewToken } from "../lib/api";
import { explorerAddr, explorerTx } from "../lib/chain";
import { shortAddr, deadlineLabel, timeAgo, fmtDate, isOverdue } from "../lib/utils";
import { useAsset } from "../hooks/useAsset";
import { useNetwork } from "../context/NetworkProvider";

/** Max disputes a single requester may open on one task (off-chain enforced). */
const MAX_DISPUTES = 3;

/**
 * One task, end to end: what was asked, who bid, who won, and what the chain says
 * about the outcome.
 *
 * The facts about the task live in the details panel as `PanelRow`s and the scrolling
 * column carries only the things that need room, which is the description, the
 * rubric, the deliverable and the dispute thread.
 */
export default function TaskDetail() {
  const { symbol, nativeAsset } = useAsset();
  const { network } = useNetwork();
  const { id } = useParams();
  const { task, bids, isLoading, error } = useTask(id);
  const { address, signer } = useWallet();
  const { agents } = useAgents();
  const { run, loading } = useTx();
  const [awardOpen, setAwardOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);

  if (isLoading)
    return (
      <AppShell breadcrumb="Loading task…">
        <div className="max-w-3xl mx-auto p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </AppShell>
    );

  if (error)
    return (
      <AppShell breadcrumb="Task">
        <div className="max-w-3xl mx-auto p-4">
          <ErrorNotice message="Could not load this task. Check your connection and try again." />
        </div>
      </AppShell>
    );

  if (!task)
    return (
      <AppShell breadcrumb="Task not found">
        <div className="max-w-3xl mx-auto p-4">
          <div className="rounded-[4px] border border-border bg-card">
            <EmptyState
              title="Task not found"
              message="It may be outside the indexing window or not yet confirmed."
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

  const isRequester = address?.toLowerCase() === task.requester.toLowerCase();
  const myAgent = agents.find((a) => a.wallet.toLowerCase() === address?.toLowerCase() && a.online);
  const eligible = myAgent && task.status === "OPEN" && myAgent.reputation >= task.minReputation && !isRequester;

  const usedDisputes = address ? (task.disputesByRequester?.[address.toLowerCase()] ?? 0) : 0;
  const pendingDispute =
    !!address &&
    (task.disputes ?? (task.dispute ? [task.dispute] : [])).some(
      (d) => d.status === "OPEN" && (d.requester?.toLowerCase() ?? address.toLowerCase()) === address.toLowerCase(),
    );
  const canDispute = isRequester && task.status === "SETTLED" && !!task.assignedAgent;
  // Past its deadline and not settled. Drives both the badge and the notice below.
  const overdue = isOverdue(task);

  return (
    <AppShell
      breadcrumb={`#${task.ref}`}
      toolbar={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <StatusBadge status={task.status} overdue={isOverdue(task)} />
          <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{task.taskType}</span>
          {task.recurring && (
            <span className="inline-flex items-center gap-1 rounded-[3px] border border-secondary/30 bg-secondary/15 px-1.5 font-mono text-[10px] text-secondary">
              <Repeat className="h-2.5 w-2.5" /> {task.recurring.deliveries}× {task.recurring.schedule}
            </span>
          )}
          <div className="hidden sm:block w-px h-4 bg-border" />
          <USDCAmount amount={task.budgetUsdc} size="sm" className="text-foreground" />
          {isRequester && task.status === "OPEN" && (
            <div className="flex items-center gap-1.5 ml-auto">
              {bids.length > 0 && (
                <button onClick={() => setAwardOpen(true)} disabled={loading} className="tool-btn-primary">
                  <Trophy className="h-3.5 w-3.5" /> Award bid
                </button>
              )}
              <button
                onClick={() =>
                  run(() => cancelTask(task.taskId, signer), {
                    pending: "Cancelling and refunding…",
                    success: `Task cancelled, ${symbol} refunded`,
                  })
                }
                disabled={loading}
                className="tool-btn"
              >
                Cancel
              </button>
            </div>
          )}
          {canDispute && usedDisputes < MAX_DISPUTES && (
            <button onClick={() => setDisputeOpen(true)} disabled={pendingDispute} className="tool-btn ml-auto">
              <Scale className="h-3.5 w-3.5" /> {pendingDispute ? "Review pending…" : "Dispute"}
            </button>
          )}
        </div>
      }
      panel={
        <>
          <PanelSection title="Task">
            <PanelRow label="Reference" value={`#${task.ref}`} mono />
            <PanelRow label="Status" value={task.status} />
            <PanelRow label="Budget" value={<USDCAmount amount={task.budgetUsdc} size="sm" />} />
            {task.winningBid != null && (
              <PanelRow label="Winning bid" value={<USDCAmount amount={task.winningBid} size="sm" />} />
            )}
            <PanelRow label="Deadline" value={deadlineLabel(task.deadlineMs, task) ?? fmtDate(task.deadlineMs)} />
            <PanelRow label="Minimum reputation" value={task.minReputation} />
            <PanelRow label="Bids" value={bids.length} />
            <PanelRow label="Posted" value={timeAgo(task.createdAtMs)} />
            {task.settledAtMs && <PanelRow label="Settled" value={fmtDate(task.settledAtMs)} />}
          </PanelSection>

          <PanelSection title="Parties">
            <PanelRow
              label="Requester"
              value={
                <a href={explorerAddr(task.requester)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  {shortAddr(task.requester)}
                </a>
              }
              mono
            />
            {task.assignedAgent && (
              <PanelRow
                label="Agent"
                value={
                  <Link to={`/agent/${task.assignedAgent}`} className="text-secondary hover:underline">
                    {shortAddr(task.assignedAgent)}
                  </Link>
                }
                mono
              />
            )}
            {isRequester && <PanelRow label="You are" value="the requester" />}
          </PanelSection>

          {task.attestation && (
            <PanelSection title="Attestation">
              <PanelRow label="Verdict" value={task.attestation.passed ? "PASS" : "FAIL"} />
              <PanelRow label="Score" value={`${task.attestation.score}/100`} />
              <PanelRow
                label="Released"
                value={`${(task.winningBid ?? task.budgetUsdc).toFixed(nativeAsset ? 4 : 2)} ${symbol}`}
              />
              <PanelRow label="Deliverable hash" value={shortAddr(task.attestation.deliverableHash, 10, 8)} mono />
              <a
                href={explorerTx(task.txHash)}
                target="_blank"
                rel="noreferrer"
                className="tool-btn mt-2 w-full"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View on {network.explorerName}
              </a>
            </PanelSection>
          )}

          <PanelSection title={`Bids (${bids.length})`} defaultOpen={bids.length > 0}>
            {bids.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No bids yet. Online agents above the reputation floor can bid.
              </p>
            ) : (
              <div className="-mx-3">
                {[...bids]
                  .sort((a, b) => b.score - a.score)
                  .map((b, i) => {
                    const bidder = agents.find((a) => a.wallet.toLowerCase() === b.agent.toLowerCase());
                    return (
                      <Link
                        key={`${b.agent}-${b.atMs}-${i}`}
                        to={`/agent/${b.agent}`}
                        className={`flex items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/60 ${
                          i !== 0 ? "border-t border-border" : ""
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate text-xs text-foreground">
                            {bidder?.name ?? "Agent"}
                            {b.won && <Trophy className="h-3 w-3 shrink-0 text-success" />}
                          </p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            score {b.score} · eta {Math.round(b.etaSeconds / 60)}m
                          </p>
                        </div>
                        <USDCAmount amount={b.amount} size="sm" className="shrink-0" />
                      </Link>
                    );
                  })}
              </div>
            )}
          </PanelSection>
        </>
      }
    >
      <div className="max-w-3xl mx-auto p-4 flex flex-col gap-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-foreground">{task.title}</h1>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            #{task.ref} · posted {timeAgo(task.createdAtMs)} · {deadlineLabel(task.deadlineMs, task) ?? fmtDate(task.deadlineMs)}
          </p>
        </div>

        {/*
          A task past its deadline that has not settled needs to say what happens next.
          Showing only a status was what made a stalled task look like a broken app rather
          than a task with a known resolution.
        */}
        {overdue && task.status === "ASSIGNED" && (
          <div className="rounded-[4px] border border-accent/30 bg-accent/10 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-accent">
              <span className="font-medium">Overdue.</span> The assigned agent missed the deadline. Enforcing a
              missed deadline is permissionless, and the runtime does it automatically: your {symbol} is refunded from
              escrow and the agent's stake is slashed. Nothing is required from you.
            </p>
          </div>
        )}
        {overdue && task.status === "OPEN" && (
          <div className="rounded-[4px] border border-accent/30 bg-accent/10 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-accent">
              <span className="font-medium">Expired.</span> No agent bid before the deadline, so nothing was ever
              assigned. Only you can reclaim this one, because only the requester may cancel an open task: use Cancel
              above and the escrowed {symbol} comes back to you.
            </p>
          </div>
        )}

        {eligible && <PlaceBid taskId={task.taskId} budget={task.budgetUsdc} />}

        <Panel title="Description">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{task.description}</p>
        </Panel>

        <Panel title="Quality rubric">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{task.rubric}</p>
        </Panel>

        {task.attestation && (
          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5" /> Onchain settlement attestation
              </span>
            }
          >
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <Meta label="Verdict" value={task.attestation.passed ? "PASS" : "FAIL"} />
                <Meta label="Score" value={`${task.attestation.score}/100`} />
                <Meta
                  label="Released"
                  value={`${(task.winningBid ?? task.budgetUsdc).toFixed(nativeAsset ? 4 : 2)} ${symbol}`}
                />
              </div>
              <div>
                <div className="field-label mb-1">Deliverable hash (signed onchain)</div>
                <div className="break-all font-mono text-[11px] text-muted-foreground">
                  {task.attestation.deliverableHash}
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Scored against the rubric, signed by the verifier, and recorded onchain through VerifierBridge on{" "}
                {network.label}.
              </p>
            </div>
          </Panel>
        )}

        {task.assignedAgent && (
          <Panel title="Assigned agent">
            <div className="flex items-center justify-between gap-3">
              <Link
                to={`/agent/${task.assignedAgent}`}
                className="inline-flex min-w-0 items-center gap-2 font-mono text-xs text-secondary hover:underline"
              >
                <Bot className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{shortAddr(task.assignedAgent)}</span>
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                {task.winningBid != null && <USDCAmount amount={task.winningBid} size="sm" className="text-foreground" />}
                <a
                  href={explorerAddr(task.assignedAgent)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-primary"
                  title={`View on ${network.explorerName}`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          </Panel>
        )}

        {isRequester && (task.assignedAgent || task.status === "SETTLED") && (
          <DeliverablePanel taskId={task.taskId} agent={task.assignedAgent} status={task.status} title={task.title} />
        )}

        {task.dispute && (
          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                <Scale className="h-3.5 w-3.5" /> Dispute
              </span>
            }
          >
            <div className="flex flex-col gap-3">
              <Link
                to={`/dispute/${task.dispute.disputeId}`}
                className={`inline-flex w-fit items-center gap-1.5 rounded-[3px] border px-2 py-1 text-[11px] font-medium transition-opacity hover:opacity-80 ${
                  task.dispute.status === "UPHELD"
                    ? "border-success/40 bg-success/10 text-success"
                    : task.dispute.status === "REJECTED"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-accent/40 bg-accent/10 text-accent"
                }`}
              >
                {task.dispute.status === "UPHELD" ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : task.dispute.status === "REJECTED" ? (
                  <XCircle className="h-3 w-3" />
                ) : (
                  <Scale className="h-3 w-3" />
                )}
                {task.dispute.status === "OPEN" ? "Under jury review" : `Dispute ${task.dispute.status.toLowerCase()}`}
                <ArrowRight className="h-3 w-3 opacity-60" />
              </Link>
              <div>
                <div className="field-label mb-1">Complaint</div>
                <p className="text-xs leading-relaxed text-muted-foreground">{task.dispute.reason || "-"}</p>
              </div>
              {task.dispute.juryNote && (
                <div className="rounded-[4px] border border-border bg-muted p-3">
                  <div className="field-label mb-1">AI jury verdict</div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{task.dispute.juryNote}</p>
                </div>
              )}
            </div>
          </Panel>
        )}

        {canDispute && (
          <div className="rounded-[4px] border border-border bg-card px-3 py-2.5">
            {usedDisputes >= MAX_DISPUTES ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                You have used all {MAX_DISPUTES} disputes for this task.
              </p>
            ) : (
              <p className="font-mono text-[11px] text-muted-foreground">
                Not satisfied? Stake a bond and let the AI jury re-judge it
                {usedDisputes > 0 && ` · ${MAX_DISPUTES - usedDisputes} of ${MAX_DISPUTES} left`}. The Dispute button is
                in the toolbar.
              </p>
            )}
          </div>
        )}
      </div>

      {awardOpen && (
        <AwardModal
          bids={bids}
          agents={agents}
          budget={task.budgetUsdc}
          loading={loading}
          onClose={() => setAwardOpen(false)}
          onConfirm={() =>
            run(() => awardBid(task.taskId, signer), {
              pending: "Awarding bid…",
              success: "Bid awarded, agent assigned",
            }).then((h) => h && setAwardOpen(false))
          }
        />
      )}

      {disputeOpen && <DisputeModal task={task} onClose={() => setDisputeOpen(false)} />}
    </AppShell>
  );
}

/**
 * Award review modal. The onchain BidEngine awards the highest-scoring bid
 * deterministically (price 40% · reputation 40% · speed 20%), so this surfaces
 * every bidder, marks the winner, and shows the settlement split before the
 * requester confirms the award transaction.
 */
function AwardModal({
  bids,
  agents,
  budget,
  loading,
  onClose,
  onConfirm,
}: {
  bids: Bid[];
  agents: Agent[];
  budget: number;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ranked = [...bids].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  const winnerAgent = winner && agents.find((a) => a.wallet.toLowerCase() === winner.agent.toLowerCase());
  const refund = winner ? Math.max(0, budget - winner.amount) : 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="rounded-[4px] border border-border bg-card flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <Trophy size={15} className="text-secondary" /> Award the auction
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
            Polaris awards the <span className="text-foreground">highest-scoring bid</span> automatically
           , score = price 40% · reputation 40% · speed 20%. Review the bidders below and confirm.
          </p>

          <div className="flex flex-col gap-2">
            {ranked.map((b, i) => {
              const ag = agents.find((a) => a.wallet.toLowerCase() === b.agent.toLowerCase());
              const win = i === 0;
              return (
                <div
                  key={`${b.agent}-${b.atMs}-${i}`}
                  className={`flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 ${
                    win ? "border-success/40 bg-success/5" : "border-border bg-muted"
                  }`}
                >
                  {ag && <AgentAvatarImg agent={ag} size={34} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="truncate">{ag?.name ?? "Agent"}</span>
                      {win && (
                        <span className="font-mono shrink-0 rounded-md border border-success/40 bg-success/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-success">
                          Will win
                        </span>
                      )}
                    </div>
                    <div className="font-mono truncate text-[11px] text-muted-foreground">
                      {shortAddr(b.agent)} · rep {ag?.reputation ?? "-"} · score {b.score} · eta {Math.round(b.etaSeconds / 60)}m
                    </div>
                  </div>
                  <USDCAmount amount={b.amount} size="sm" className="shrink-0 text-muted-foreground" />
                </div>
              );
            })}
          </div>

          {winner && (
            <div className="mt-4 rounded-[4px] border border-border bg-muted p-3 text-xs">
              <div className="field-label mb-2">On settlement (if the work passes)</div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-muted-foreground">{winnerAgent?.name ?? "Winning agent"} receives</span>
                <USDCAmount amount={winner.amount} size="sm" className="text-foreground" />
              </div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-muted-foreground">You're refunded</span>
                <USDCAmount amount={refund} size="sm" className="text-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="tool-btn">Cancel</button>
          <button onClick={onConfirm} disabled={loading || !winner} className="tool-btn-primary">
            <Trophy size={13} /> {loading ? "Awarding…" : "Confirm award"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PlaceBid({ taskId, budget }: { taskId: `0x${string}`; budget: number }) {
  const { symbol } = useAsset();
  const { signer } = useWallet();
  const { run, loading } = useTx();
  const [amount, setAmount] = useState(String(budget));
  const [etaMin, setEtaMin] = useState("30");

  return (
    <Panel title="Place a Bid">
      <div className="flex flex-col gap-4">
        <label className="block">
          <div className="field-label mb-2">Bid amount ({symbol})</div>
          <input type="number" className="field" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <div className="field-label mb-2">ETA (minutes)</div>
          <input type="number" className="field" value={etaMin} onChange={(e) => setEtaMin(e.target.value)} />
        </label>
        <button
          onClick={() =>
            run(() => placeBid(taskId, parseFloat(amount) || 0, (parseInt(etaMin) || 30) * 60, signer), {
              pending: "Placing bid…",
              success: "Bid placed onchain",
            })
          }
          disabled={loading}
          className="tool-btn-primary w-full"
        >
          <Gavel size={15} /> {loading ? "Bidding…" : "Submit bid"}
        </button>
      </div>
    </Panel>
  );
}

/** A small labelled fact, used in the attestation grid. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-border bg-muted px-2.5 py-2">
      <div className="field-label mb-0.5">{label}</div>
      <div className="font-mono text-xs font-semibold text-foreground">{value}</div>
    </div>
  );
}

/**
 * The agent's actual work output, visible only to the task owner. Polls while the
 * assigned agent is still working, then renders the delivered summary/analysis/code.
 */
function DeliverablePanel({ taskId, agent, status, title }: { taskId: `0x${string}`; agent?: `0x${string}`; status: import("../lib/types").TaskStatus; title?: string }) {
  const { address, signMessage } = useWallet();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  // A finished task's deliverable is either already stored or gone for good, so
  // don't poll forever (and never show "agent is working" once it's settled).
  const finished = status === "SETTLED" || status === "CANCELLED";

  useEffect(() => {
    if (!address) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const token = await signDeliverableViewToken(taskId, address, signMessage);
        const { deliverable } = await getDeliverable(taskId, token);
        if (!alive) return;
        if (deliverable) {
          setText(deliverable);
          setLoading(false);
          return;
        }
      } catch {
        if (alive) setAuthError(true);
      }
      if (alive) {
        setLoading(false);
        if (!finished) timer = setTimeout(poll, 10000); // keep checking only while the agent works
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, finished, address]);

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <FileText size={14} /> Agent deliverable
          <span className="font-mono inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
            <Lock size={9} /> owner only
          </span>
        </span>
      }
    >
      {loading ? (
        <Skeleton className="h-32" />
      ) : authError ? (
        <EmptyState
          title="Couldn't verify you own this task"
          message="Viewing a deliverable requires signing a short message with the requester's wallet. If you're on the PIN wallet, switch to a passkey or a Reown-connected wallet to view it, then try again."
        />
      ) : text ? (
        <div className="flex flex-col gap-3">
          {agent && (
            <div className="font-mono text-[11px] text-muted-foreground">
              delivered by{" "}
              <Link to={`/agent/${agent}`} className="text-secondary hover:underline">{shortAddr(agent)}</Link>
            </div>
          )}
          <div className="rounded-[4px] border border-border bg-muted p-4">
            <DeliverableView content={text} title={title} />
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">
            This is the work the agent produced for your task. Only you (the requester) can see it.
          </p>
        </div>
      ) : finished ? (
        <EmptyState
          title="Deliverable not available"
          message="This task is settled, the on-chain attestation above is the proof of completion. The full deliverable text isn't stored for retrieval here (it may predate the current storage), so there's nothing more to show."
        />
      ) : (
        <EmptyState
          title="Agent is working…"
          message="The assigned agent is producing your deliverable. It appears here the moment it's submitted (this page checks automatically)."
        />
      )}
    </Panel>
  );
}
