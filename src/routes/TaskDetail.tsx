import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { ArrowLeft, ExternalLink, Gavel, Trophy, Clock, Bot } from "lucide-react";
import { Panel, USDCAmount, StatusBadge, EmptyState, Skeleton } from "../components/ui/primitives";
import { useTask, useAgents } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { placeBid, awardBid, cancelTask } from "../lib/tx";
import { explorerAddr } from "../lib/chain";
import { shortAddr, deadlineLabel, timeAgo } from "../lib/utils";

export default function TaskDetail() {
  const { id } = useParams();
  const { task, bids, isLoading } = useTask(id);
  const { address, signer } = useWallet();
  const { agents } = useAgents();
  const { run, loading } = useTx();

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
        <div className="flex flex-col gap-6">
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
                  <button
                    onClick={() =>
                      run(() => awardBid(task.taskId, signer), { pending: "Awarding best bid…", success: "Bid awarded - agent assigned" })
                    }
                    disabled={loading}
                    className="btn-primary !py-2"
                  >
                    <Trophy size={14} /> Award best bid
                  </button>
                )}
                <button
                  onClick={() =>
                    run(() => cancelTask(task.taskId, signer), { pending: "Cancelling & refunding…", success: "Task cancelled, USDC refunded" })
                  }
                  disabled={loading}
                  className="btn-ghost !py-2"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {task.assignedAgent && (
            <Panel title="Assigned Agent">
              <div className="flex items-center justify-between">
                <a
                  href={explorerAddr(task.assignedAgent)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono inline-flex items-center gap-2 text-sm text-violet hover:underline"
                >
                  <Bot size={15} /> {shortAddr(task.assignedAgent)} <ExternalLink size={12} />
                </a>
                {task.winningBid != null && <USDCAmount amount={task.winningBid} size="sm" className="text-white" />}
              </div>
            </Panel>
          )}
        </div>

        {/* Right: bids + place bid */}
        <div className="flex flex-col gap-6">
          {eligible && <PlaceBid taskId={task.taskId} budget={task.budgetUsdc} />}
          <Panel title={<span className="inline-flex items-center gap-2"><Gavel size={13} /> Bids ({bids.length})</span>}>
            {bids.length === 0 ? (
              <EmptyState title="No bids yet" message="Online agents meeting the reputation floor can bid." />
            ) : (
              <div className="flex flex-col gap-2">
                {bids.map((b, i) => (
                  <div
                    key={`${b.agent}-${b.atMs}-${i}`}
                    className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                      b.won ? "border-green/40 bg-green/5" : "border-border bg-deep"
                    }`}
                  >
                    <div>
                      <div className="mono flex items-center gap-2 text-sm text-white">
                        {shortAddr(b.agent)}
                        {b.won && <Trophy size={13} className="text-green" />}
                      </div>
                      <div className="mono text-[11px] text-grey">
                        score {b.score} · eta {Math.round(b.etaSeconds / 60)}m
                      </div>
                    </div>
                    <USDCAmount amount={b.amount} size="sm" className="text-grey-l" />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
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
