import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useParams, Link } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { ArrowLeft, ExternalLink, Gavel, Trophy, Clock, Bot, ShieldCheck, Coins, FileText, Lock, X, Scale, CheckCircle2, XCircle, Repeat } from "lucide-react";
import { Panel, USDCAmount, StatusBadge, EmptyState, Skeleton } from "../components/ui/primitives";
import { AgentAvatarImg } from "../components/AgentAvatar";
import DisputeModal from "../components/DisputeModal";
import type { Agent, Bid } from "../lib/types";
import { useTask, useAgents } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { placeBid, awardBid, cancelTask } from "../lib/tx";
import { getDeliverable } from "../lib/api";
import { explorerAddr, explorerTx } from "../lib/chain";
import { shortAddr, deadlineLabel, timeAgo } from "../lib/utils";

export default function TaskDetail() {
  const { id } = useParams();
  const { task, bids, isLoading } = useTask(id);
  const { address, signer } = useWallet();
  const { agents } = useAgents();
  const { run, loading } = useTx();
  const [awardOpen, setAwardOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!task)
    return (
      <div className="panel">
        <EmptyState
          title="Task not found"
          message="It may be outside the indexing window or not yet confirmed."
          action={<Link to="/tasks" className="btn-ghost">Back to market</Link>}
        />
      </div>
    );

  const isRequester = address?.toLowerCase() === task.requester.toLowerCase();
  const myAgent = agents.find(
    (a) => a.wallet.toLowerCase() === address?.toLowerCase() && a.online,
  );
  const eligible =
    myAgent && task.status === "OPEN" && myAgent.reputation >= task.minReputation && !isRequester;

  return (
    <div>
      <Link to="/tasks" className="mono mb-5 inline-flex items-center gap-1.5 text-xs text-grey hover:text-grey-l">
        <ArrowLeft size={14} /> Back to market
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-3">
            <StatusBadge status={task.status} />
            <span className="mono text-xs text-grey">#{task.ref}</span>
            <span className="mono rounded-md border border-border bg-deep px-2 py-0.5 text-[10px] uppercase tracking-wider text-grey-l">
              {task.taskType}
            </span>
            {task.recurring && (
              <span className="mono inline-flex items-center gap-1 rounded-md border border-violet/40 bg-violet/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-violet">
                <Repeat size={10} /> recurring · {task.recurring.deliveries}× · {task.recurring.schedule}
              </span>
            )}
          </div>
          <h1 className="text-3xl font-bold tracking-tightest text-white">{task.title}</h1>
        </div>
        <div className="text-right">
          <div className="eyebrow mb-1">Budget</div>
          <USDCAmount amount={task.budgetUsdc} size="xl" className="text-white" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* Left: details */}
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Description">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-grey-l">{task.description}</p>
          </Panel>
          <Panel title="Quality Rubric">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-grey-l">{task.rubric}</p>
          </Panel>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Meta icon={<Clock size={14} />} label="Deadline" value={deadlineLabel(task.deadlineMs)} />
            <Meta icon={<Trophy size={14} />} label="Min Rep" value={String(task.minReputation)} />
            <Meta icon={<Gavel size={14} />} label="Bids" value={String(bids.length)} />
            <Meta icon={<Clock size={14} />} label="Posted" value={timeAgo(task.createdAtMs)} />
          </div>

          <div className="panel flex items-center justify-between p-4">
            <div>
              <div className="eyebrow mb-1">Requester</div>
              <a
                href={explorerAddr(task.requester)}
                target="_blank"
                rel="noreferrer"
                className="mono inline-flex items-center gap-1.5 text-sm text-blue-l hover:underline"
              >
                {shortAddr(task.requester)} <ExternalLink size={12} />
              </a>
            </div>
            {isRequester && task.status === "OPEN" && (
              <div className="flex gap-2">
                {bids.length > 0 && (
                  <button onClick={() => setAwardOpen(true)} disabled={loading} className="btn-primary btn-sm">
                    <Trophy size={13} /> Award bid
                  </button>
                )}
                <button
                  onClick={() =>
                    run(() => cancelTask(task.taskId, signer), { pending: "Cancelling & refunding…", success: "Task cancelled, USDC refunded" })
                  }
                  disabled={loading}
                  className="btn-ghost btn-sm"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {task.assignedAgent && (
            <Panel title="Assigned Agent">
              <div className="flex items-center justify-between">
                <Link
                  to={`/agent/${task.assignedAgent}`}
                  className="mono inline-flex items-center gap-2 text-sm text-violet hover:underline"
                >
                  <Bot size={15} /> {shortAddr(task.assignedAgent)}
                </Link>
                <div className="flex items-center gap-3">
                  {task.winningBid != null && <USDCAmount amount={task.winningBid} size="sm" className="text-white" />}
                  <a href={explorerAddr(task.assignedAgent)} target="_blank" rel="noreferrer" className="text-grey hover:text-blue-l" title="View on Arcscan">
                    <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            </Panel>
          )}

          {task.attestation && (
            <Panel title={<span className="inline-flex items-center gap-2"><ShieldCheck size={14} /> Onchain settlement attestation</span>}>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Meta icon={<ShieldCheck size={14} />} label="Verdict" value={task.attestation.passed ? "PASS" : "FAIL"} />
                  <Meta icon={<Trophy size={14} />} label="Score" value={`${task.attestation.score}/100`} />
                  <Meta icon={<Coins size={14} />} label="Released" value={`${(task.winningBid ?? task.budgetUsdc).toFixed(2)} USDC`} />
                </div>
                {task.assignedAgent && (
                  <div>
                    <div className="eyebrow mb-1">Settled by agent</div>
                    <Link to={`/agent/${task.assignedAgent}`} className="mono text-sm text-violet hover:underline">
                      {shortAddr(task.assignedAgent, 10, 8)}
                    </Link>
                  </div>
                )}
                <div>
                  <div className="eyebrow mb-1">Deliverable hash (signed onchain)</div>
                  <div className="mono break-all text-[11px] text-grey-l">{task.attestation.deliverableHash}</div>
                </div>
                <a
                  href={explorerTx(task.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost w-full !py-2"
                >
                  <ExternalLink size={14} /> View on Arcscan
                </a>
                <p className="mono text-[11px] leading-relaxed text-grey">
                  Scored by our algorithm against the rubric, signed by the verifier, and recorded onchain via
                  VerifierBridge. Status: <span className="text-green">SETTLED</span>.
                </p>
              </div>
            </Panel>
          )}

          {isRequester && (task.assignedAgent || task.status === "SETTLED") && (
            <DeliverablePanel taskId={task.taskId} agent={task.assignedAgent} />
          )}

          {/* Dispute (Phase C) — status if disputed, else a control for the requester */}
          {task.dispute ? (
            <Panel title={<span className="inline-flex items-center gap-2"><Scale size={14} /> Dispute</span>}>
              <div className="flex flex-col gap-3">
                <div className={`inline-flex w-fit items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-semibold ${
                  task.dispute.status === "UPHELD" ? "border-green/40 bg-green/5 text-green"
                  : task.dispute.status === "REJECTED" ? "border-red/40 bg-red/5 text-red"
                  : "border-amber-400/40 bg-amber-400/10 text-amber-300"
                }`}>
                  {task.dispute.status === "UPHELD" ? <CheckCircle2 size={13} /> : task.dispute.status === "REJECTED" ? <XCircle size={13} /> : <Scale size={13} />}
                  {task.dispute.status === "OPEN" ? "Under jury review" : `Dispute ${task.dispute.status.toLowerCase()}`}
                </div>
                <div>
                  <div className="eyebrow mb-1">Complaint</div>
                  <p className="text-sm leading-relaxed text-grey-l">{task.dispute.reason || "—"}</p>
                </div>
                {task.dispute.juryNote && (
                  <div className="rounded-xl border border-border bg-deep p-3">
                    <div className="eyebrow mb-1">AI jury verdict</div>
                    <p className="text-sm leading-relaxed text-grey-l">{task.dispute.juryNote}</p>
                  </div>
                )}
              </div>
            </Panel>
          ) : (
            isRequester && task.status === "SETTLED" && task.assignedAgent && (
              <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">Not satisfied with the work?</div>
                  <div className="mono text-[11px] text-grey">Stake a bond and let the AI jury re-judge it.</div>
                </div>
                <button onClick={() => setDisputeOpen(true)} className="btn-ghost btn-sm"><Scale size={13} /> Dispute</button>
              </div>
            )
          )}
        </div>

        {/* Right: bids + place bid */}
        <div className="flex min-w-0 flex-col gap-6">
          {eligible && <PlaceBid taskId={task.taskId} budget={task.budgetUsdc} />}
          <Panel title={<span className="inline-flex items-center gap-2"><Gavel size={13} /> Bids ({bids.length})</span>}>
            {bids.length === 0 ? (
              <EmptyState title="No bids yet" message="Online agents meeting the reputation floor can bid." />
            ) : (
              <div className="flex flex-col gap-2">
                {bids.map((b, i) => {
                  const bidder = agents.find((a) => a.wallet.toLowerCase() === b.agent.toLowerCase());
                  return (
                    <div
                      key={`${b.agent}-${b.atMs}-${i}`}
                      className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
                        b.won ? "border-green/40 bg-green/5" : "border-border bg-deep"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-white">
                          <Link to={`/agent/${b.agent}`} className="truncate hover:text-violet">
                            {bidder?.name ?? "Agent"}
                          </Link>
                          {b.won && <Trophy size={13} className="shrink-0 text-green" />}
                        </div>
                        <div className="mono truncate text-[11px] text-grey">
                          {shortAddr(b.agent)} · score {b.score} · eta {Math.round(b.etaSeconds / 60)}m · {timeAgo(b.atMs)}
                        </div>
                      </div>
                      <USDCAmount amount={b.amount} size="sm" className="shrink-0 text-grey-l" />
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
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
              success: "Bid awarded - agent assigned",
            }).then((h) => h && setAwardOpen(false))
          }
        />
      )}

      {disputeOpen && <DisputeModal task={task} onClose={() => setDisputeOpen(false)} />}
    </div>
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="panel flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-white">
            <Trophy size={15} className="text-violet" /> Award the auction
          </div>
          <button onClick={onClose} className="text-grey hover:text-white"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-xs leading-relaxed text-grey-l">
            Polaris awards the <span className="text-white">highest-scoring bid</span> automatically
            — score = price 40% · reputation 40% · speed 20%. Review the bidders below and confirm.
          </p>

          <div className="flex flex-col gap-2">
            {ranked.map((b, i) => {
              const ag = agents.find((a) => a.wallet.toLowerCase() === b.agent.toLowerCase());
              const win = i === 0;
              return (
                <div
                  key={`${b.agent}-${b.atMs}-${i}`}
                  className={`flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 ${
                    win ? "border-green/40 bg-green/5" : "border-border bg-deep"
                  }`}
                >
                  {ag && <AgentAvatarImg agent={ag} size={34} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-white">
                      <span className="truncate">{ag?.name ?? "Agent"}</span>
                      {win && (
                        <span className="mono shrink-0 rounded-md border border-green/40 bg-green/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-green">
                          Will win
                        </span>
                      )}
                    </div>
                    <div className="mono truncate text-[11px] text-grey">
                      {shortAddr(b.agent)} · rep {ag?.reputation ?? "—"} · score {b.score} · eta {Math.round(b.etaSeconds / 60)}m
                    </div>
                  </div>
                  <USDCAmount amount={b.amount} size="sm" className="shrink-0 text-grey-l" />
                </div>
              );
            })}
          </div>

          {winner && (
            <div className="mt-4 rounded-xl border border-border bg-deep p-3 text-xs">
              <div className="eyebrow mb-2">On settlement (if the work passes)</div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-grey-l">{winnerAgent?.name ?? "Winning agent"} receives</span>
                <USDCAmount amount={winner.amount} size="sm" className="text-white" />
              </div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-grey-l">You're refunded</span>
                <USDCAmount amount={refund} size="sm" className="text-white" />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancel</button>
          <button onClick={onConfirm} disabled={loading || !winner} className="btn-primary btn-sm">
            <Trophy size={13} /> {loading ? "Awarding…" : "Confirm award"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PlaceBid({ taskId, budget }: { taskId: `0x${string}`; budget: number }) {
  const { signer } = useWallet();
  const { run, loading } = useTx();
  const [amount, setAmount] = useState(String(budget));
  const [etaMin, setEtaMin] = useState("30");

  return (
    <Panel title="Place a Bid">
      <div className="flex flex-col gap-4">
        <label className="block">
          <div className="eyebrow mb-2">Bid amount (USDC)</div>
          <input type="number" className="input-field" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <div className="eyebrow mb-2">ETA (minutes)</div>
          <input type="number" className="input-field" value={etaMin} onChange={(e) => setEtaMin(e.target.value)} />
        </label>
        <button
          onClick={() =>
            run(() => placeBid(taskId, parseFloat(amount) || 0, (parseInt(etaMin) || 30) * 60, signer), {
              pending: "Placing bid…",
              success: "Bid placed onchain",
            })
          }
          disabled={loading}
          className="btn-primary w-full"
        >
          <Gavel size={15} /> {loading ? "Bidding…" : "Submit bid"}
        </button>
      </div>
    </Panel>
  );
}

function Meta({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="panel p-4">
      <div className="eyebrow mb-1.5 flex items-center gap-1.5">{icon} {label}</div>
      <div className="mono text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

/**
 * The agent's actual work output, visible only to the task owner. Polls while the
 * assigned agent is still working, then renders the delivered summary/analysis/code.
 */
function DeliverablePanel({ taskId, agent }: { taskId: `0x${string}`; agent?: `0x${string}` }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { deliverable } = await getDeliverable(taskId);
        if (!alive) return;
        if (deliverable) {
          setText(deliverable);
          setLoading(false);
          return;
        }
      } catch {
        /* ignore */
      }
      if (alive) {
        setLoading(false);
        timer = setTimeout(poll, 10000); // keep checking while the agent works
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [taskId]);

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <FileText size={14} /> Agent deliverable
          <span className="mono inline-flex items-center gap-1 rounded-md border border-border bg-deep px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-grey">
            <Lock size={9} /> owner only
          </span>
        </span>
      }
    >
      {loading ? (
        <Skeleton className="h-32" />
      ) : text ? (
        <div className="flex flex-col gap-3">
          {agent && (
            <div className="mono text-[11px] text-grey">
              delivered by{" "}
              <Link to={`/agent/${agent}`} className="text-violet hover:underline">{shortAddr(agent)}</Link>
            </div>
          )}
          <div className="max-h-[480px] overflow-y-auto rounded-xl border border-border bg-deep p-4">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-grey-l">{text}</pre>
          </div>
          <p className="mono text-[11px] text-grey">
            This is the work the agent produced for your task. Only you (the requester) can see it.
          </p>
        </div>
      ) : (
        <EmptyState
          title="Agent is working…"
          message="The assigned agent is producing your deliverable. It appears here the moment it's submitted (this page checks automatically)."
        />
      )}
    </Panel>
  );
}
