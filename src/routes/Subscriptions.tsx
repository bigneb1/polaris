import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Repeat, CalendarClock, FileText, XCircle, CheckCircle2, ChevronDown, Gavel, Store, Scale, Loader2 } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, USDCAmount, EmptyState, ErrorNotice, Skeleton, ProgressBar } from "../components/ui/primitives";
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
 * The recurring dashboard: market plans this wallet auctioned, and direct
 * subscriptions it funds.
 *
 * The two kinds work differently enough to deserve a filter rather than one merged
 * list: a market plan is escrowed then auctioned, so nobody is assigned until an agent
 * wins it, while a direct subscription names its agent up front.
 */
export default function Subscriptions() {
  const { address } = useWallet();
  const { subscriptions, isLoading, error } = useSubscriptions(address ? { subscriber: address } : undefined);
  const { plans, isLoading: plansLoading, error: plansError } = useRecurringPlans(address ? { requester: address } : undefined);
  const { agents } = useAgents();
  const [tab, setTab] = useState<"plans" | "subs">("plans");

  const escrowed =
    plans.reduce((n, p) => n + p.escrowedUsdc, 0) + subscriptions.reduce((n, s) => n + s.escrowedUsdc, 0);
  const delivered =
    plans.reduce((n, p) => n + p.done, 0) + subscriptions.reduce((n, s) => n + s.deliveriesDone, 0);
  const dueNow =
    plans.reduce((n, p) => n + Math.max(0, Math.min(p.total, p.dueNow) - p.done), 0) +
    subscriptions.reduce((n, s) => n + Math.max(0, Math.min(s.totalDeliveries, s.dueNow) - s.deliveriesDone), 0);

  if (!address)
    return (
      <AppShell>
        <div className="max-w-4xl mx-auto p-4">
          <div className="rounded-[4px] border border-border bg-card">
            <EmptyState
              title="Connect a wallet"
              message="Connect to see and manage your recurring plans and subscriptions."
            />
          </div>
        </div>
      </AppShell>
    );

  return (
    <AppShell
      toolbar={
        <div className="flex items-center gap-0.5">
          <button data-active={tab === "plans"} onClick={() => setTab("plans")} className="tool-btn">
            <Store className="h-3.5 w-3.5" /> Market plans
            <span className="text-muted-foreground">{plans.length}</span>
          </button>
          <button data-active={tab === "subs"} onClick={() => setTab("subs")} className="tool-btn">
            <Repeat className="h-3.5 w-3.5" /> Direct subscriptions
            <span className="text-muted-foreground">{subscriptions.length}</span>
          </button>
        </div>
      }
      panel={
        <>
          <PanelSection title="Your recurring work">
            <PanelRow label="Market plans" value={plans.length} />
            <PanelRow label="Direct subscriptions" value={subscriptions.length} />
            <PanelRow label="Deliveries received" value={delivered} />
            <PanelRow label="Due now" value={dueNow} />
            <PanelRow label="Escrow remaining" value={<USDCAmount amount={escrowed} size="sm" />} />
          </PanelSection>
          <PanelSection title="Plans versus subscriptions" defaultOpen={false}>
            <p className="text-xs leading-relaxed text-muted-foreground">
              A market plan is escrowed up front and auctioned: agents bid, the best-scored one wins, and each
              scheduled drop releases one slice onchain. A direct subscription skips the auction because you picked
              the agent yourself. Either way the whole plan is escrowed at creation, and cancelling refunds whatever
              has not been delivered.
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-4xl mx-auto p-4">
        {tab === "plans" ? (
          plansError ? (
            <ErrorNotice message="Could not load your market plans." />
          ) : plansLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : plans.length === 0 ? (
            <div className="rounded-[4px] border border-border bg-card">
              <EmptyState
                title="No market plans yet"
                message="Create a task, switch it to Recurring, and it is auctioned to the swarm. The winning agent then delivers on your schedule."
                action={
                  <Link to="/create-task" className="tool-btn">
                    Create a recurring task
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {plans.map((p) => (
                <PlanCard
                  key={p.planId}
                  plan={p}
                  agent={p.agent ? agents.find((a) => a.wallet.toLowerCase() === p.agent!.toLowerCase()) : undefined}
                />
              ))}
            </div>
          )
        ) : error ? (
          <ErrorNotice message="Could not load your subscriptions." />
        ) : isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : subscriptions.length === 0 ? (
          <div className="rounded-[4px] border border-border bg-card">
            <EmptyState
              title="No subscriptions yet"
              message="Open an agent and choose Subscribe (recurring) to set up scheduled deliveries with that agent."
              action={
                <Link to="/explorer" className="tool-btn">
                  Browse agents
                </Link>
              }
            />
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {subscriptions.map((s) => (
              <SubCard
                key={s.subId}
                sub={s}
                agent={agents.find((a) => a.wallet.toLowerCase() === s.agent.toLowerCase())}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
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
  // Reuses the app's badge vocabulary rather than inventing a fourth colour scheme.
  const statusCls =
    plan.status === "ACTIVE" ? "status-verified"
    : plan.status === "OPEN" ? "status-open"
    : plan.status === "COMPLETE" ? "status-submitted"
    : "status-rejected";

  return (
    <Panel
      title={
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-2">
            {agent ? <AgentAvatarImg agent={agent} size={22} /> : <Store className="h-4 w-4 text-muted-foreground" />}
            <span className="truncate text-foreground">{agent?.name ?? (plan.status === "OPEN" ? "Awaiting bids" : "Unassigned")}</span>
          </span>
          <span className={`status-badge shrink-0 ${statusCls}`}>{plan.status.toLowerCase()}</span>
        </div>
      }
    >
      <div className="min-w-0">
        <div className="mb-1 truncate text-[13px] font-medium text-foreground">{plan.title}</div>
        <div className="font-mono mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" /> {plan.schedule}</span>
          <span>· started {fmtDate(plan.createdAtMs)}</span>
          {plan.status === "OPEN" && <span className="inline-flex items-center gap-1 text-primary"><Gavel className="h-3 w-3" /> {plan.bidCount} bid{plan.bidCount === 1 ? "" : "s"}</span>}
        </div>

        {plan.status !== "OPEN" && (
          <div className="mb-3">
            <div className="font-mono mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{plan.done}/{plan.total} delivered</span>
              <span>
                {Math.max(0, Math.min(plan.total, plan.dueNow) - plan.done) > 0 ? "due now"
                  : plan.status === "ACTIVE" ? <Countdown to={plan.nextDueMs} className="text-primary" />
                  : plan.status === "COMPLETE" ? "complete"
                  : "up to date"}
              </span>
            </div>
            <ProgressBar value={pct} />
          </div>
        )}

        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-[4px] border border-border bg-muted p-2.5">
            <div className="field-label mb-1">{plan.status === "OPEN" ? "Max per delivery" : "Per delivery (won)"}</div>
            <USDCAmount amount={plan.status === "OPEN" ? plan.perDeliveryUsdc : plan.priceUsdc} size="sm" className="text-foreground" />
          </div>
          <div className="rounded-[4px] border border-border bg-muted p-2.5">
            <div className="field-label mb-1">Escrow remaining</div>
            <USDCAmount amount={plan.escrowedUsdc} size="sm" className="text-foreground" />
          </div>
        </div>

        {plan.deliveries.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            <div className="field-label">Deliveries</div>
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
            className="tool-btn w-full"
          >
            <XCircle className="h-3.5 w-3.5" /> Cancel &amp; refund remaining
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
    <div className="rounded-[4px] border border-border bg-muted">
      <button onClick={toggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          <span className="truncate">#{index + 1} · {preview || "delivered"}</span>
        </span>
        <span className="font-mono inline-flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">{score}/100 · {timeAgo(atMs)} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} /></span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><FileText className="h-3 w-3" /> deliverable</div>
          {full === null ? <Skeleton className="h-16" /> : <DeliverableView content={full} compact />}
          {hash && (
            <div className="mt-2">
              <div className="field-label mb-0.5">Deliverable hash (signed onchain)</div>
              <div className="font-mono break-all text-[10px] text-muted-foreground">{hash}</div>
            </div>
          )}

          {verdict ? (
            <div className={`mt-3 rounded-[4px] border px-3 py-2 ${verdict.upheld ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"}`}>
              <div className={`font-mono inline-flex items-center gap-1.5 text-[11px] font-semibold ${verdict.upheld ? "text-success" : "text-destructive"}`}>
                <Scale className="h-3 w-3" /> Delivery dispute {verdict.upheld ? "UPHELD" : "REJECTED"}
              </div>
              {verdict.juryNote && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{verdict.juryNote}</p>}
              {verdict.upheld && <p className="font-mono mt-1 text-[10px] text-muted-foreground">This drop was already paid (pay-per-delivery). Cancel the plan to reclaim the remaining escrow.</p>}
            </div>
          ) : disputing ? (
            <div className="mt-3 flex flex-col gap-2">
              <textarea className="field-area min-h-[60px]" placeholder="Why is this delivery inadequate?" value={reason} onChange={(e) => setReason(e.target.value)} />
              {err && <div className="font-mono text-[11px] text-destructive">{err}</div>}
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setDisputing(false)} className="tool-btn">Cancel</button>
                <button onClick={submitDispute} disabled={busy || !reason.trim()} className="tool-btn-primary">
                  {busy ? <><Loader2 className="h-3 w-3 animate-spin" /> Jury judging…</> : <><Scale className="h-3 w-3" /> Dispute this delivery</>}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setDisputing(true)} className="font-mono mt-3 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-accent">
              <Scale className="h-3 w-3" /> Dispute this delivery
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
            {agent && <AgentAvatarImg agent={agent} size={22} />}
            <Link to={`/agent/${sub.agent}`} className="truncate text-foreground hover:text-secondary">{agent?.name ?? shortAddr(sub.agent)}</Link>
          </span>
          <span className={`status-badge shrink-0 ${sub.active ? "status-verified" : "status-rejected"}`}>
            {sub.active ? "active" : sub.deliveriesDone >= sub.totalDeliveries ? "complete" : "ended"}
          </span>
        </div>
      }
    >
      <div className="min-w-0">
        <div className="mb-1 truncate text-[13px] font-medium text-foreground">{sub.title}</div>
        <div className="font-mono mb-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CalendarClock className="h-3 w-3" /> {sub.schedule} · started {fmtDate(sub.createdAtMs)}
        </div>

        <div className="mb-3">
          <div className="font-mono mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{sub.deliveriesDone}/{sub.totalDeliveries} delivered</span>
            <span>
              {pending > 0 ? `${pending} due now`
                : sub.active ? <Countdown to={sub.nextDueMs} className="text-primary" />
                : sub.deliveriesDone >= sub.totalDeliveries ? "complete"
                : "up to date"}
            </span>
          </div>
          <ProgressBar value={pct} />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-[4px] border border-border bg-muted p-2.5">
            <div className="field-label mb-1">Per delivery</div>
            <USDCAmount amount={sub.perDeliveryUsdc} size="sm" className="text-foreground" />
          </div>
          <div className="rounded-[4px] border border-border bg-muted p-2.5">
            <div className="field-label mb-1">Escrow remaining</div>
            <USDCAmount amount={sub.escrowedUsdc} size="sm" className="text-foreground" />
          </div>
        </div>

        {sub.deliveries.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            <div className="field-label">Deliveries</div>
            {sub.deliveries.map((d) => (
              <DeliveryRow key={d.index} subId={sub.subId} index={d.index} score={d.score} atMs={d.atMs} preview={d.preview} hash={d.hash} />
            ))}
          </div>
        )}

        {sub.active && (
          <button
            onClick={() => run(() => cancelSubscription(sub.subId, signer), { pending: "Cancelling & refunding…", success: "Subscription cancelled, escrow refunded" })}
            disabled={loading}
            className="tool-btn w-full"
          >
            <XCircle className="h-3.5 w-3.5" /> Cancel & refund remaining
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
    <div className="rounded-[4px] border border-border bg-muted">
      <button onClick={toggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          <span className="truncate">#{index + 1} · {preview || "delivered"}</span>
        </span>
        <span className="font-mono inline-flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          {score}/100 · {timeAgo(atMs)} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><FileText className="h-3 w-3" /> deliverable</div>
          {full === null ? <Skeleton className="h-16" /> : <DeliverableView content={full} compact />}
          {hash && (
            <div className="mt-2">
              <div className="field-label mb-0.5">Deliverable hash (signed onchain)</div>
              <div className="font-mono break-all text-[10px] text-muted-foreground">{hash}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
