import { useState } from "react";
import { Link } from "react-router-dom";
import { Repeat, CalendarClock, FileText, XCircle, CheckCircle2, ChevronDown } from "lucide-react";
import { Panel, USDCAmount, EmptyState, Skeleton, ProgressBar } from "../components/ui/primitives";
import { AgentAvatarImg } from "../components/AgentAvatar";
import { useWallet } from "../context/WalletProvider";
import { useSubscriptions, useAgents } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { cancelSubscription } from "../lib/tx";
import { getSubDeliverable } from "../lib/api";
import { shortAddr, fmtDate, timeAgo } from "../lib/utils";
import type { Subscription, Agent } from "../lib/types";

/**
 * Subscriptions dashboard — the recurring plans the connected wallet funds.
 * Shows delivery progress, escrow remaining, schedule, the drops received so
 * far, and a cancel-with-refund control.
 */
export default function Subscriptions() {
  const { address } = useWallet();
  const { subscriptions, isLoading } = useSubscriptions(address ? { subscriber: address } : undefined);
  const { agents } = useAgents();

  if (!address)
    return (
      <div className="panel">
        <EmptyState title="Connect a wallet" message="Connect to see and manage your recurring subscriptions." />
      </div>
    );

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tightest text-white">
          <Repeat size={22} className="text-violet" /> Subscriptions
        </h1>
        <p className="mt-1 text-sm text-grey-l">Recurring plans you fund — deliverables arrive on your schedule.</p>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : subscriptions.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No subscriptions yet"
            message="Open an agent and choose “Subscribe (recurring)” to set up scheduled deliveries."
            action={<Link to="/explorer" className="btn-ghost btn-sm">Browse agents</Link>}
          />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {subscriptions.map((s) => (
            <SubCard key={s.subId} sub={s} agent={agents.find((a) => a.wallet.toLowerCase() === s.agent.toLowerCase())} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubCard({ sub, agent }: { sub: Subscription; agent?: Agent }) {
  const { signer } = useWallet();
  const { run, loading } = useTx();
  const pct = sub.totalDeliveries ? (sub.deliveriesDone / sub.totalDeliveries) * 100 : 0;
  const pending = Math.max(0, Math.min(sub.totalDeliveries, sub.dueNow) - sub.deliveriesDone);

  return (
    <Panel
      title={
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-2">
            {agent && <AgentAvatarImg agent={agent} size={26} />}
            <Link to={`/agent/${sub.agent}`} className="truncate text-white hover:text-violet">{agent?.name ?? shortAddr(sub.agent)}</Link>
          </span>
          <span className={`mono shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            sub.active ? "border-green/40 bg-green/10 text-green" : "border-border bg-deep text-grey"
          }`}>
            {sub.active ? "active" : sub.deliveriesDone >= sub.totalDeliveries ? "complete" : "ended"}
          </span>
        </div>
      }
    >
      <div className="min-w-0">
        <div className="mb-1 truncate text-sm font-medium text-white">{sub.title}</div>
        <div className="mono mb-3 flex items-center gap-1.5 text-[11px] text-grey">
          <CalendarClock size={12} /> {sub.schedule} · started {fmtDate(sub.createdAtMs)}
        </div>

        <div className="mb-3">
          <div className="mono mb-1.5 flex items-center justify-between text-[11px] text-grey-l">
            <span>{sub.deliveriesDone}/{sub.totalDeliveries} delivered</span>
            <span>{pending > 0 ? `${pending} due now` : "up to date"}</span>
          </div>
          <ProgressBar value={pct} />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border bg-deep p-2.5">
            <div className="eyebrow mb-1">Per delivery</div>
            <USDCAmount amount={sub.perDeliveryUsdc} size="sm" className="text-white" />
          </div>
          <div className="rounded-lg border border-border bg-deep p-2.5">
            <div className="eyebrow mb-1">Escrow remaining</div>
            <USDCAmount amount={sub.escrowedUsdc} size="sm" className="text-white" />
          </div>
        </div>

        {sub.deliveries.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            <div className="eyebrow">Deliveries</div>
            {sub.deliveries.map((d) => (
              <DeliveryRow key={d.index} subId={sub.subId} index={d.index} score={d.score} atMs={d.atMs} preview={d.preview} />
            ))}
          </div>
        )}

        {sub.active && (
          <button
            onClick={() => run(() => cancelSubscription(sub.subId, signer), { pending: "Cancelling & refunding…", success: "Subscription cancelled, escrow refunded" })}
            disabled={loading}
            className="btn-ghost btn-sm w-full"
          >
            <XCircle size={13} /> Cancel & refund remaining
          </button>
        )}
      </div>
    </Panel>
  );
}

function DeliveryRow({ subId, index, score, atMs, preview }: { subId: string; index: number; score: number; atMs: number; preview: string }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);

  const toggle = async () => {
    setOpen((o) => !o);
    if (!full) {
      const { deliverable } = await getSubDeliverable(subId, index);
      setFull(deliverable);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-deep">
      <button onClick={toggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs text-grey-l">
          <CheckCircle2 size={13} className="shrink-0 text-green" />
          <span className="truncate">#{index + 1} · {preview || "delivered"}</span>
        </span>
        <span className="mono inline-flex shrink-0 items-center gap-1.5 text-[10px] text-grey">
          {score}/100 · {timeAgo(atMs)} <ChevronDown size={12} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] text-grey"><FileText size={11} /> deliverable</div>
          {full === null ? (
            <Skeleton className="h-16" />
          ) : (
            <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-grey-l">{full}</pre>
          )}
        </div>
      )}
    </div>
  );
}
