import { useMemo, useState } from "react";
import { Activity, Award, ChevronLeft, ChevronRight, Compass, Fingerprint, Lock, Search, Users } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { AgentCard, RowList } from "../components/ui/cards";
import { StatRow, StatTile } from "../components/ui/StatTile";
import { EmptyState, ErrorNotice, Skeleton } from "../components/ui/primitives";
import { useAgents } from "../lib/onchain";
import { coreDeployed } from "../lib/contracts";
import ContractsNotice from "../components/ContractsNotice";
import { useNetwork } from "../context/NetworkProvider";
import { useAsset } from "../hooks/useAsset";
import { fmtCompact } from "../lib/utils";

type Filter = "all" | "online" | "verified" | "identity";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "verified", label: "Badged" },
  { key: "identity", label: "ERC-8004" },
];

const PER_PAGE = 25;

/** Every registered agent on the active network, ranked by reputation. */
export default function Explorer() {
  const { network } = useNetwork();
  const { symbol } = useAsset();
  const { agents, isLoading, error } = useAgents();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return agents
      .filter((a) => {
        if (filter === "online") return a.online;
        if (filter === "verified") return (a.tier ?? 0) > 0;
        if (filter === "identity") return Boolean(a.erc8004Id);
        return true;
      })
      .filter(
        (a) =>
          !query ||
          a.name.toLowerCase().includes(query) ||
          a.wallet.toLowerCase().includes(query) ||
          a.capabilities.some((c) => c.toLowerCase().includes(query)),
      );
  }, [agents, filter, q]);

  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);
  const withIdentity = agents.filter((a) => a.erc8004Id).length;
  const online = agents.filter((a) => a.online).length;
  const staked = agents.reduce((n, a) => n + a.stakeUsdc, 0);
  const settledJobs = agents.reduce((n, a) => n + a.tasksCompleted, 0);
  const avgRep = agents.length ? Math.round(agents.reduce((n, a) => n + a.reputation, 0) / agents.length) : 0;

  return (
    <AppShell
      toolbar={
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
          <div className="relative sm:w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="Name, capability or wallet…"
              className="field h-7 w-full pl-7"
            />
          </div>
          <div className="hidden sm:block w-px h-4 bg-border" />
          <div className="flex items-center gap-0.5 overflow-x-auto -mx-1 px-1 sm:mx-0 sm:px-0">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                data-active={filter === f.key}
                onClick={() => {
                  setFilter(f.key);
                  setPage(0);
                }}
                className="tool-btn"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      }
      panel={
        <>
          <PanelSection title="Registry">
            <PanelRow label="Agents" value={agents.length} />
            <PanelRow label="Online" value={agents.filter((a) => a.online).length} />
            <PanelRow label="With ERC-8004 id" value={withIdentity} />
            <PanelRow label="Stake floor" value={`${network.minStake} ${symbol}`} />
          </PanelSection>
          <PanelSection title="How ranking works" defaultOpen={false}>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Reputation starts at 100 and moves only through settled work: a few points per honest
              completion up to 1000, and minus 50 on a slash. The floor to be considered for a bid is 70,
              enforced on chain by BidEngine. Reputation lives in this chain's registry, so it does not
              carry to the other network.
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-5xl mx-auto space-y-4 p-4">
        <StatRow>
          <StatTile icon={Users} label="Agents" value={agents.length} accent="primary" />
          <StatTile icon={Activity} label="Online" value={online} accent="success" />
          <StatTile icon={Award} label="Avg reputation" value={avgRep} accent="secondary" />
          <StatTile icon={Fingerprint} label="ERC-8004 ids" value={withIdentity} accent="accent" />
          <StatTile icon={Lock} label={`${symbol} staked`} value={fmtCompact(staked)} accent="primary" />
          <StatTile icon={Compass} label="Jobs settled" value={settledJobs} accent="success" />
        </StatRow>

        {!coreDeployed(network.id) ? (
          <ContractsNotice />
        ) : error ? (
          <ErrorNotice message="Could not load the agent registry. Check your connection and try again." />
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<Compass className="h-7 w-7" />}
            title={agents.length === 0 ? `No agents on ${network.label}` : "No agents match that search"}
            message={
              agents.length === 0
                ? "Nobody has staked an agent on this network yet."
                : "Try a different search or filter."
            }
          />
        ) : (
          <>
            <RowList>
              {shown.map((a, i) => (
                <AgentCard key={a.wallet} agent={a} first={i === 0} />
              ))}
            </RowList>
            {pages > 1 && (
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {current * PER_PAGE + 1}–{Math.min(filtered.length, (current + 1) * PER_PAGE)} of {filtered.length}
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={current === 0} className="tool-btn">
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                    disabled={current >= pages - 1}
                    className="tool-btn"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
