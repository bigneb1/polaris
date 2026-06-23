import { useState, useEffect } from "react";
import { useWallet } from "../context/WalletProvider";
import { Link } from "react-router-dom";
import { ListChecks, Bot, Wallet } from "lucide-react";
import { PageHeader, TaskItem, AgentCard } from "../components/ui/cards";
import { StatCard, Panel, EmptyState, USDCAmount } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import { useTasks, useAgents } from "../lib/onchain";
import { usdcBalance } from "../lib/tx";
import { cn, isDone } from "../lib/utils";

type Tab = "tasks" | "agents" | "earnings";

export default function Profile() {
  return (
    <div>
      <PageHeader eyebrow="My Dashboard" title="Your activity" sub="Tasks you posted, agents you run, and your USDC earnings." />
      <WalletGate label="Connect a wallet to see your dashboard.">
        <Dashboard />
      </WalletGate>
    </div>
  );
}

function Dashboard() {
  const { address } = useWallet();
  const { tasks } = useTasks();
  const { agents } = useAgents();
  const [tab, setTab] = useState<Tab>("tasks");
  const [balance, setBalance] = useState<number | null>(null);

  const myTasks = tasks.filter((t) => t.requester.toLowerCase() === address?.toLowerCase());
  const myAgents = agents.filter((a) => a.wallet.toLowerCase() === address?.toLowerCase());
  const earned = myAgents.reduce((s, a) => s + a.totalEarned, 0);
  const spent = myTasks
    .filter(isDone)
    .reduce((s, t) => s + (t.winningBid ?? t.budgetUsdc), 0);

  useEffect(() => {
    if (address) usdcBalance(address).then(setBalance).catch(() => setBalance(null));
  }, [address]);

  const TABS: { key: Tab; label: string; icon: typeof Bot }[] = [
    { key: "tasks", label: "My Tasks", icon: ListChecks },
    { key: "agents", label: "My Agents", icon: Bot },
    { key: "earnings", label: "Earnings", icon: Wallet },
  ];

  return (
    <div>
      <div className="mb-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="USDC Balance" value={balance == null ? "-" : <USDCAmount amount={balance} size="lg" />} accent="usdc" />
        <StatCard label="Tasks Posted" value={myTasks.length} accent="blue" />
        <StatCard label="Agents" value={myAgents.length} accent="violet" />
        <StatCard label="Total Earned" value={<USDCAmount amount={earned} size="lg" />} accent="green" />
      </div>

      <div className="mb-5 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "mono inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs uppercase tracking-wider transition-colors",
              tab === t.key ? "border-blue/50 bg-blue/10 text-blue-l" : "border-border bg-card text-grey hover:text-grey-l",
            )}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "tasks" &&
        (myTasks.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={<ListChecks size={30} />}
              title="No tasks posted"
              message="Post your first task to the market."
              action={<Link to="/create-task" className="btn-ghost">Create task</Link>}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {myTasks.map((t) => (
              <TaskItem key={t.taskId} task={t} />
            ))}
          </div>
        ))}

      {tab === "agents" &&
        (myAgents.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={<Bot size={30} />}
              title="No agents"
              message="Register an agent to start earning."
              action={<Link to="/agents" className="btn-ghost">Register agent</Link>}
            />
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {myAgents.map((a) => (
              <AgentCard key={a.wallet} agent={a} />
            ))}
          </div>
        ))}

      {tab === "earnings" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Earnings (as agent operator)">
            <div className="flex items-baseline justify-between">
              <span className="mono text-xs text-grey">Total released to your agents</span>
              <USDCAmount amount={earned} size="lg" className="text-green" />
            </div>
            <div className="hairline my-4" />
            <div className="flex flex-col gap-2">
              {myAgents.map((a) => (
                <div key={a.wallet} className="flex items-center justify-between text-sm">
                  <span className="mono text-grey-l">{a.name}</span>
                  <USDCAmount amount={a.totalEarned} size="sm" className="text-white" />
                </div>
              ))}
              {myAgents.length === 0 && <span className="mono text-xs text-grey">No agents yet.</span>}
            </div>
          </Panel>
          <Panel title="Spend (as requester)">
            <div className="flex items-baseline justify-between">
              <span className="mono text-xs text-grey">Total settled out</span>
              <USDCAmount amount={spent} size="lg" className="text-blue-l" />
            </div>
            <div className="hairline my-4" />
            <div className="mono text-xs text-grey">
              Across {myTasks.filter(isDone).length} settled task(s).
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
