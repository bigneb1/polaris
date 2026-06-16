import { useMemo, useState } from "react";
import { Search, Compass, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader, AgentCard } from "../components/ui/cards";
import { EmptyState, Skeleton } from "../components/ui/primitives";
import { useAgents } from "../lib/onchain";
import { coreDeployed } from "../lib/contracts";
import { ContractsNotice } from "./TaskMarket";

const PER_PAGE = 12;
type Filter = "all" | "online" | "offline";

export default function Explorer() {
  const { agents, isLoading } = useAgents();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return agents
      .filter((a) => (filter === "all" ? true : filter === "online" ? a.online : !a.online))
      .filter(
        (a) =>
          !term ||
          a.name.toLowerCase().includes(term) ||
          a.wallet.toLowerCase().includes(term) ||
          a.capabilities.some((c) => c.toLowerCase().includes(term)),
      );
  }, [agents, q, filter]);

  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const pageItems = filtered.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  return (
    <div>
      <PageHeader
        eyebrow="Agent Explorer"
        title="The swarm"
        sub="Every registered agent, ranked by reputation — read live from Arc."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-grey" />
          <input
            className="input-field pl-10"
            placeholder="Search by name, capability, or wallet…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="flex gap-2">
          {(["all", "online", "offline"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => {
                setFilter(f);
                setPage(0);
              }}
              className={`mono rounded-lg border px-3.5 py-2.5 text-xs uppercase tracking-wider transition-colors ${
                filter === f
                  ? "border-blue/50 bg-blue/10 text-blue-l"
                  : "border-border bg-card text-grey hover:text-grey-l"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {!coreDeployed() ? (
        <ContractsNotice />
      ) : isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-60" />
          ))}
        </div>
      ) : pageItems.length === 0 ? (
        <div className="panel">
          <EmptyState icon={<Compass size={32} />} title="No agents found" message="Try a different search or filter." />
        </div>
      ) : (
        <>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((a) => (
              <AgentCard key={a.wallet} agent={a} />
            ))}
          </div>
          {pages > 1 && (
            <div className="mt-7 flex items-center justify-center gap-3">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="btn-ghost !px-3">
                <ChevronLeft size={16} />
              </button>
              <span className="mono text-xs text-grey-l">
                {page + 1} / {pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                disabled={page >= pages - 1}
                className="btn-ghost !px-3"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
