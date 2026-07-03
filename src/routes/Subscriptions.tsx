import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Repeat, CalendarClock, FileText, XCircle, CheckCircle2, ChevronDown, Gavel, Store, Scale, Loader2 } from "lucide-react";
import { Panel, USDCAmount, EmptyState, Skeleton, ProgressBar } from "../components/ui/primitives";
import { AgentAvatarImg } from "../components/AgentAvatar";
import { DeliverableView } from "../components/DeliverableView";
import { Countdown } from "../components/Countdown";
import { useWallet } from "../context/WalletProvider";
import { useSubscriptions, useAgents, useRecurringPlans } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { cancelSubscription, cancelPlan } from "../lib/tx";
import { getSubDeliverable, getPlanDeliverable, getRecurringDisputes, disputeRecurringDelivery, type DeliveryVerdict } from "../lib/api";
import { shortAddr, fmtDate, timeAgo } from "../lib/utils";
import type { Subscription, Agent, RecurringPlan } from "../lib/types";

/**
 * Subscriptions dashboard — the recurring plans the connected wallet funds.
 * Shows delivery progress, escrow remaining, schedule, the drops received so
 * far, and a cancel-with-refund control.
 */
export default function Subscriptions() {
  const { address } = useWallet();
  const { subscriptions, isLoading } = useSubscriptions(address ? { subscriber: address } : undefined);
  const { plans } = useRecurringPlans(address ? { requester: address } : undefined);
  const { agents } = useAgents();

  if (!address)
    return (
      <div className="panel">
        <EmptyState title="Connect a wallet" message="Connect to see and manage your recurring plans and subscriptions." />
      </div>
    );

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tightest text-white">
          <Repeat size={22} className="text-violet" /> Recurring
        </h1>
        <p className="mt-1 text-sm text-grey-l">Market plans you auctioned and direct subscriptions you fund — deliverables arrive on your schedule.</p>
      </div>

      {/* Market recurring plans (auctioned) */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Store size={15} className="text-blue-l" /> Market plans</h2>
      {plans.length === 0 ? (
        <div className="panel mb-8">
          <EmptyState
            title="No market plans yet"
            message="Create a task, switch it to “Recurring”, and it's auctioned to the swarm — the winning agent delivers on your schedule."
            action={<Link to="/create-task" className="btn-ghost btn-sm">Create a recurring task</Link>}
          />
        </div>
      ) : (
        <div className="mb-8 grid gap-5 lg:grid-cols-2">
          {plans.map((p) => (
            <PlanCard key={p.planId} plan={p} agent={p.agent ? agents.find((a) => a.wallet.toLowerCase() === p.agent!.toLowerCase()) : undefined} />
          ))}
        </div>
      )}

      {/* Direct subscriptions (pick-an-agent) */}
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white"><Repeat size={15} className="text-violet" /> Direct subscriptions</h2>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : subscriptions.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No subscriptions yet"
            message="Open an agent and choose “Subscribe (recurring)” to set up scheduled deliveries with that agent."
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

export function PlanCard({ plan, agent }: { plan: RecurringPlan; agent?: Agent }) {
  const { address, signer } = useWallet();
  const { run, loading } = useTx();
  const [verdicts, setVerdicts] = useState<Record<number, DeliveryVerdict>>({});
  useEffect(() => {
    if (plan.deliveries.length) getRecurringDisputes(plan.planId).then(setVerdicts).catch(() => {});
  }, [plan.planId, plan.deliveries.length]);
  const pct = plan.total ? (plan.done / plan.total) * 100 : 0;
  const statusCls =
    plan.status === "ACTIVE" ? "border-green/40 bg-green/10 text-green"
    : plan.status === "OPEN" ? "border-blue/40 bg-blue/10 text-blue-l"
    : plan.status === "COMPLETE" ? "border-violet/40 bg-violet/10 text-violet"
    : "border-border bg-deep text-grey";

  return (
    <Panel
      title={
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-2">
            {agent ? <AgentAvatarImg agent={agent} size={26} /> : <Store size={16} className="text-grey" />}
            <span className="truncate text-white">{agent?.name ?? (plan.status === "OPEN" ? "Awaiting bids" : "Unassigned")}</span>
          </span>
          <span className={`mono shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${statusCls}`}>{plan.status.toLowerCase()}</span>
        </div>
      }
    >
      <div className="min-w-0">
        <div className="mb-1 truncate text-sm font-medium text-white">{plan.title}</div>
        <div className="mono mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-grey">
          <span className="inline-flex items-center gap-1"><CalendarClock size={12} /> {plan.schedule}</span>
          <span>· started {fmtDate(plan.createdAtMs)}</span>
          {plan.status === "OPEN" && <span className="inline-flex items-center gap-1 text-blue-l"><Gavel size={11} /> {plan.bidCount} bid{plan.bidCount === 1 ? "" : "s"}</span>}
        </div>

        {plan.status !== "OPEN" && (
          <div className="mb-3">
            <div className="mono mb-1.5 flex items-center justify-between text-[11px] text-grey-l">
              <span>{plan.done}/{plan.total} delivered</span>
              <span>
                {Math.max(0, Math.min(plan.total, plan.dueNow) - plan.done) > 0 ? "due now"
                  : plan.status === "ACTIVE" ? <Countdown to={plan.nextDueMs} className="text-blue-l" />
                  : plan.status === "COMPLETE" ? "complete"
                  : "up to date"}
              </span>
            </div>
            <ProgressBar value={pct} />
          </div>
        )}

        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border bg-deep p-2.5">
            <div className="eyebrow mb-1">{plan.status === "OPEN" ? "Max per delivery" : "Per delivery (won)"}</div>
            <USDCAmount amount={plan.status === "OPEN" ? plan.perDeliveryUsdc : plan.priceUsdc} size="sm" className="text-white" />
          </div>
          <div className="rounded-lg border border-border bg-deep p-2.5">
            <div className="eyebrow mb-1">Escrow remaining</div>
            <USDCAmount amount={plan.escrowedUsdc} size="sm" className="text-white" />
          </div>
        </div>

        {plan.deliveries.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            <div className="eyebrow">Deliveries</div>
            {plan.deliveries.map((d) => (
              <PlanDeliveryRow
                key={d.index}
                planId={plan.planId}
                index={d.index}
                score={d.score}
                atMs={d.atMs}
                preview={d.preview}
                hash={d.hash}
                reporter={address ?? undefined}
                verdict={verdicts[d.index]}
                onDisputed={(v) => setVerdicts((m) => ({ ...m, [d.index]: v }))}
              />
            ))}
          </div>
        )}

        {(plan.status === "OPEN" || plan.status === "ACTIVE") && (
          <button
            onClick={() => run(() => cancelPlan(plan.planId, signer), { pending: "Cancelling & refunding…", success: "Plan cancelled, escrow refunded" })}
            disabled={loading}
            className="btn-ghost btn-sm w-full"
          >
            <XCircle size={13} /> Cancel &amp; refund remaining
          </button>
        )}
      </div>
    </Panel>
  );
}

function PlanDeliveryRow({ planId, index, score, atMs, preview, hash, reporter, verdict, onDisputed }: { planId: string; index: number; score: number; atMs: number; preview: string; hash?: string; reporter?: string; verdict?: DeliveryVerdict; onDisputed: (v: DeliveryVerdict) => void }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    setOpen((o) => !o);
    if (!full) setFull((await getPlanDeliverable(planId, index)).deliverable);
  };
  const submitDispute = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await disputeRecurringDelivery(planId, index, reason.trim(), reporter);
      if (r.error) throw new Error(r.error);
      onDisputed({ index, upheld: !!r.upheld, juryNote: r.juryNote || "", complaint: reason.trim(), atMs: Date.now() });
      setDisputing(false);
    } catch (e) {
      setErr((e as Error).message || "Dispute failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-border bg-deep">
      <button onClick={toggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs text-grey-l">
          <CheckCircle2 size={13} className="shrink-0 text-green" />
          <span className="truncate">#{index + 1} · {preview || "delivered"}</span>
        </span>
        <span className="mono inline-flex shrink-0 items-center gap-1.5 text-[10px] text-grey">{score}/100 · {timeAgo(atMs)} <ChevronDown size={12} className={open ? "rotate-180" : ""} /></span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] text-grey"><FileText size={11} /> deliverable</div>
          {full === null ? <Skeleton className="h-16" /> : <DeliverableView content={full} compact />}
          {hash && (
            <div className="mt-2">
              <div className="eyebrow mb-0.5">Deliverable hash (signed onchain)</div>
              <div className="mono break-all text-[10px] text-grey">{hash}</div>
            </div>
          )}

          {verdict ? (
            <div className={`mt-3 rounded-lg border px-3 py-2 ${verdict.upheld ? "border-green/40 bg-green/5" : "border-red/40 bg-red/5"}`}>
              <div className={`mono inline-flex items-center gap-1.5 text-[11px] font-semibold ${verdict.upheld ? "text-green" : "text-red"}`}>
                <Scale size={11} /> Delivery dispute {verdict.upheld ? "UPHELD" : "REJECTED"}
              </div>
              {verdict.juryNote && <p className="mt-1 text-[12px] leading-relaxed text-grey-l">{verdict.juryNote}</p>}
              {verdict.upheld && <p className="mono mt-1 text-[10px] text-grey">This drop was already paid (pay-per-delivery). Cancel the plan to reclaim the remaining escrow.</p>}
            </div>
          ) : disputing ? (
            <div className="mt-3 flex flex-col gap-2">
              <textarea className="input-field min-h-[60px] text-[13px]" placeholder="Why is this delivery inadequate?" value={reason} onChange={(e) => setReason(e.target.value)} />
              {err && <div className="mono text-[11px] text-red">{err}</div>}
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setDisputing(false)} className="btn-ghost btn-sm">Cancel</button>
                <button onClick={submitDispute} disabled={busy || !reason.trim()} className="btn-primary btn-sm">
                  {busy ? <><Loader2 size={12} className="animate-spin" /> Jury judging…</> : <><Scale size={12} /> Dispute this delivery</>}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setDisputing(true)} className="mono mt-3 inline-flex items-center gap-1.5 text-[11px] text-grey transition-colors hover:text-amber">
              <Scale size={11} /> Dispute this delivery
            </button>
          )}
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
            <span>
              {pending > 0 ? `${pending} due now`
                : sub.active ? <Countdown to={sub.nextDueMs} className="text-blue-l" />
                : sub.deliveriesDone >= sub.totalDeliveries ? "complete"
                : "up to date"}
            </span>
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
              <DeliveryRow key={d.index} subId={sub.subId} index={d.index} score={d.score} atMs={d.atMs} preview={d.preview} hash={d.hash} />
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

function DeliveryRow({ subId, index, score, atMs, preview, hash }: { subId: string; index: number; score: number; atMs: number; preview: string; hash?: string }) {
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
          {full === null ? <Skeleton className="h-16" /> : <DeliverableView content={full} compact />}
          {hash && (
            <div className="mt-2">
              <div className="eyebrow mb-0.5">Deliverable hash (signed onchain)</div>
              <div className="mono break-all text-[10px] text-grey">{hash}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
