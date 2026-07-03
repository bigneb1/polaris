import { useParams, Link } from "react-router-dom";
import { ArrowLeft, FileText, ClipboardCheck, Gavel, Trophy } from "lucide-react";
import { Panel, EmptyState, Skeleton, USDCAmount } from "../components/ui/primitives";
import { PlanCard } from "./Subscriptions";
import { useRecurringPlans, useAgents } from "../lib/onchain";
import { shortAddr } from "../lib/utils";

/** Detail page for a recurring task (market plan) — reached by clicking a plan
 *  on the Task Market "Recurring" tab or the /subscriptions dashboard. */
export default function PlanDetail() {
  const { planId } = useParams();
  const { plans, isLoading } = useRecurringPlans();
  const { agents } = useAgents();

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  const plan = plans.find((p) => p.planId.toLowerCase() === (planId ?? "").toLowerCase());
  if (!plan)
    return (
      <div className="panel">
        <EmptyState
          title="Recurring task not found"
          message="It may be outside the indexing window or not yet confirmed on-chain."
          action={<Link to="/tasks" className="btn-ghost">Back to market</Link>}
        />
      </div>
    );

  const agent = plan.agent ? agents.find((a) => a.wallet.toLowerCase() === plan.agent!.toLowerCase()) : undefined;

  return (
    <div>
      <Link to="/tasks" className="mono mb-5 inline-flex items-center gap-1.5 text-xs text-grey hover:text-grey-l">
        <ArrowLeft size={13} /> Back to market
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="min-w-0">
          <PlanCard plan={plan} agent={agent} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title={<span className="inline-flex items-center gap-2"><FileText size={14} /> Brief</span>}>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-grey-l">{plan.brief || "—"}</p>
          </Panel>
          <Panel title={<span className="inline-flex items-center gap-2"><ClipboardCheck size={14} /> Quality rubric</span>}>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-grey-l">{plan.rubric || "—"}</p>
          </Panel>
          <Panel title={<span className="inline-flex items-center gap-2"><Gavel size={13} /> Bids ({plan.bids?.length ?? 0})</span>}>
            {!plan.bids?.length ? (
              <EmptyState title="No bids yet" message="Online agents meeting the reputation floor bid to win this recurring plan." />
            ) : (
              <div className="flex flex-col gap-2">
                {plan.bids.map((b, i) => {
                  const bidder = agents.find((a) => a.wallet.toLowerCase() === b.agent.toLowerCase());
                  const won = plan.agent?.toLowerCase() === b.agent.toLowerCase();
                  return (
                    <div key={`${b.agent}-${i}`} className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${won ? "border-green/40 bg-green/5" : "border-border bg-deep"}`}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-white">
                          <Link to={`/agent/${b.agent}`} className="truncate hover:text-violet">{bidder?.name ?? "Agent"}</Link>
                          {won && <Trophy size={13} className="shrink-0 text-green" />}
                        </div>
                        <div className="mono truncate text-[11px] text-grey">{shortAddr(b.agent)} · score {b.score}</div>
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
    </div>
  );
}
