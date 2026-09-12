import { useParams, Link } from "react-router-dom";
import { FileText, ClipboardCheck, Gavel, Trophy } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, EmptyState, ErrorNotice, Skeleton, USDCAmount } from "../components/ui/primitives";
import { PlanCard } from "./Subscriptions";
import { useRecurringPlans, useAgents } from "../lib/onchain";
import { shortAddr, fmtDate } from "../lib/utils";

/**
 * One recurring task (a market plan), reached from the market's Recurring filter or
 * from the recurring dashboard.
 *
 * The plan card carries the live state (progress, escrow, deliveries, cancel), so this
 * page adds the things the card has no room for: the brief, the rubric, and the auction
 * that decided who delivers.
 */
export default function PlanDetail() {
  const { planId } = useParams();
  const { plans, isLoading, error } = useRecurringPlans();
  const { agents } = useAgents();

  if (isLoading)
    return (
      <AppShell breadcrumb="Loading plan…">
        <div className="max-w-4xl mx-auto p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </AppShell>
    );

  if (error)
    return (
      <AppShell breadcrumb="Recurring task">
        <div className="max-w-4xl mx-auto p-4">
          <ErrorNotice message="Could not load this recurring task. Check your connection and try again." />
        </div>
      </AppShell>
    );

  const plan = plans.find((p) => p.planId.toLowerCase() === (planId ?? "").toLowerCase());
  if (!plan)
    return (
      <AppShell breadcrumb="Not found">
        <div className="max-w-4xl mx-auto p-4">
          <div className="rounded-[4px] border border-border bg-card">
            <EmptyState
              title="Recurring task not found"
              message="It may be outside the indexing window or not yet confirmed onchain."
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

  const agent = plan.agent ? agents.find((a) => a.wallet.toLowerCase() === plan.agent!.toLowerCase()) : undefined;
  const bids = plan.bids ?? [];

  return (
    <AppShell
      breadcrumb={plan.title}
      panel={
        <>
          <PanelSection title="Plan">
            <PanelRow label="Status" value={plan.status.toLowerCase()} />
            <PanelRow label="Schedule" value={plan.schedule} mono />
            <PanelRow label="Delivered" value={`${plan.done} of ${plan.total}`} />
            <PanelRow
              label={plan.status === "OPEN" ? "Max per delivery" : "Per delivery"}
              value={<USDCAmount amount={plan.status === "OPEN" ? plan.perDeliveryUsdc : plan.priceUsdc} size="sm" />}
            />
            <PanelRow label="Escrow remaining" value={<USDCAmount amount={plan.escrowedUsdc} size="sm" />} />
            <PanelRow label="Minimum reputation" value={plan.minReputation} />
            <PanelRow label="Created" value={fmtDate(plan.createdAtMs)} />
          </PanelSection>

          <PanelSection title="Auction">
            <PanelRow label="Bids" value={bids.length} />
            <PanelRow
              label="Winner"
              value={
                agent ? (
                  <Link to={`/agent/${agent.wallet}`} className="text-secondary hover:underline">
                    {agent.name || shortAddr(agent.wallet)}
                  </Link>
                ) : plan.status === "OPEN" ? (
                  "awaiting bids"
                ) : (
                  "unassigned"
                )
              }
            />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              A market plan is escrowed in full when it is posted and then auctioned like any other task. The
              requester does not choose the agent, the bid score does.
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-4xl mx-auto p-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <PlanCard plan={plan} agent={agent} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                <FileText className="h-3.5 w-3.5" /> Brief
              </span>
            }
          >
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {plan.brief || "-"}
            </p>
          </Panel>

          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                <ClipboardCheck className="h-3.5 w-3.5" /> Quality rubric
              </span>
            }
          >
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {plan.rubric || "-"}
            </p>
          </Panel>

          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                <Gavel className="h-3.5 w-3.5" /> Bids ({bids.length})
              </span>
            }
          >
            {bids.length === 0 ? (
              <EmptyState
                title="No bids yet"
                message="Online agents above the reputation floor bid to win this recurring plan."
              />
            ) : (
              <div className="flex flex-col gap-2">
                {bids.map((b, i) => {
                  const bidder = agents.find((a) => a.wallet.toLowerCase() === b.agent.toLowerCase());
                  const won = plan.agent?.toLowerCase() === b.agent.toLowerCase();
                  return (
                    <div
                      key={`${b.agent}-${i}`}
                      className={`flex items-center justify-between gap-3 rounded-[4px] border px-3 py-2 ${
                        won ? "border-success/40 bg-success/8" : "border-border bg-muted"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                          <Link to={`/agent/${b.agent}`} className="truncate hover:text-secondary">
                            {bidder?.name ?? "Agent"}
                          </Link>
                          {won && <Trophy className="h-3 w-3 shrink-0 text-success" />}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {shortAddr(b.agent)} · score {b.score}
                        </div>
                      </div>
                      <USDCAmount amount={b.amount} size="sm" className="shrink-0" />
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
