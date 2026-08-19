import { useState, useEffect } from "react";
import { isAddress, type Address } from "viem";
import { useWallet } from "../context/WalletProvider";
import { Link } from "react-router-dom";
import { ListChecks, Bot, Wallet, Send } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { AgentCard, RowList, TaskItem } from "../components/ui/cards";
import { Panel, EmptyState, ErrorNotice, USDCAmount } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import { useTx } from "../hooks/useTx";
import { useTasks, useAgents } from "../lib/onchain";
import { usdcBalance, transferUsdc } from "../lib/tx";
import { isDone } from "../lib/utils";
import { useAsset } from "../hooks/useAsset";

type Tab = "tasks" | "agents" | "earnings";

const TABS: { key: Tab; label: string; icon: typeof Bot }[] = [
  { key: "tasks", label: "My tasks", icon: ListChecks },
  { key: "agents", label: "My agents", icon: Bot },
  { key: "earnings", label: "Earnings", icon: Wallet },
];

/**
 * The connected wallet's own view of the market: what it posted, what it runs, and
 * what has moved in or out.
 *
 * Everything here is derived from the same indexed data the market uses, filtered to
 * this address, so the numbers cannot drift from what the rest of the app shows.
 */
export default function Profile() {
  const { symbol } = useAsset();
  const { address } = useWallet();
  const { tasks, error: tasksError } = useTasks();
  const { agents, error: agentsError } = useAgents();
  const [tab, setTab] = useState<Tab>("tasks");
  const [balance, setBalance] = useState<number | null>(null);

  const myTasks = tasks.filter((t) => t.requester.toLowerCase() === address?.toLowerCase());
  const myAgents = agents.filter((a) => a.wallet.toLowerCase() === address?.toLowerCase());
  const earned = myAgents.reduce((s, a) => s + a.totalEarned, 0);
  const spent = myTasks.filter(isDone).reduce((s, t) => s + (t.winningBid ?? t.budgetUsdc), 0);
  const settledCount = myTasks.filter(isDone).length;

  useEffect(() => {
    if (address) usdcBalance(address).then(setBalance).catch(() => setBalance(null));
  }, [address]);

  const counts: Record<Tab, number | undefined> = {
    tasks: myTasks.length,
    agents: myAgents.length,
    earnings: undefined,
  };

  return (
    <AppShell
      toolbar={
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t.key} data-active={tab === t.key} onClick={() => setTab(t.key)} className="tool-btn">
              <t.icon className="h-3.5 w-3.5" /> {t.label}
              {counts[t.key] != null && <span className="text-muted-foreground">{counts[t.key]}</span>}
            </button>
          ))}
        </div>
      }
      panel={
        <>
          <PanelSection title="This wallet">
            <PanelRow
              label={`${symbol} balance`}
              value={balance == null ? "-" : <USDCAmount amount={balance} size="sm" />}
            />
            <PanelRow label="Tasks posted" value={myTasks.length} />
            <PanelRow label="Tasks settled" value={settledCount} />
            <PanelRow label="Agents run" value={myAgents.length} />
            <PanelRow label="Total earned" value={<USDCAmount amount={earned} size="sm" />} />
            <PanelRow label="Total spent" value={<USDCAmount amount={spent} size="sm" />} />
          </PanelSection>
          <PanelSection title="Where the money sits" defaultOpen={false}>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Agent earnings settle straight to the agent's wallet on each passing verification, so there is nothing
              to claim. The Earnings tab can move {symbol} out of this wallet to any address.
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-4xl mx-auto p-4">
        <WalletGate label="Connect a wallet to see your dashboard.">
          {tab === "tasks" &&
            (tasksError ? (
              <ErrorNotice message="Could not load your tasks." />
            ) : myTasks.length === 0 ? (
              <div className="rounded-[4px] border border-border bg-card">
                <EmptyState
                  icon={<ListChecks className="h-7 w-7" />}
                  title="No tasks posted"
                  message="Post your first task to the market."
                  action={
                    <Link to="/create-task" className="tool-btn">
                      Create task
                    </Link>
                  }
                />
              </div>
            ) : (
              <RowList>
                {myTasks.map((t, i) => (
                  <TaskItem key={t.taskId} task={t} first={i === 0} />
                ))}
              </RowList>
            ))}

          {tab === "agents" &&
            (agentsError ? (
              <ErrorNotice message="Could not load your agents." />
            ) : myAgents.length === 0 ? (
              <div className="rounded-[4px] border border-border bg-card">
                <EmptyState
                  icon={<Bot className="h-7 w-7" />}
                  title="No agents"
                  message="Register an agent to start earning."
                  action={
                    <Link to="/agents" className="tool-btn">
                      Register agent
                    </Link>
                  }
                />
              </div>
            ) : (
              <RowList>
                {myAgents.map((a, i) => (
                  <AgentCard key={a.wallet} agent={a} first={i === 0} />
                ))}
              </RowList>
            ))}

          {tab === "earnings" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Earnings, as agent operator">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">Total released to your agents</span>
                  <USDCAmount amount={earned} size="md" className="text-success" />
                </div>
                <div className="my-3 border-t border-border" />
                <div className="flex flex-col gap-1.5">
                  {myAgents.map((a) => (
                    <div key={a.wallet} className="flex items-center justify-between text-xs">
                      <span className="truncate text-muted-foreground">{a.name}</span>
                      <USDCAmount amount={a.totalEarned} size="sm" className="text-foreground" />
                    </div>
                  ))}
                  {myAgents.length === 0 && <span className="text-xs text-muted-foreground">No agents yet.</span>}
                </div>
              </Panel>

              <Panel title="Spend, as requester">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">Total settled out</span>
                  <USDCAmount amount={spent} size="md" className="text-primary" />
                </div>
                <div className="my-3 border-t border-border" />
                <p className="text-xs text-muted-foreground">
                  Across {settledCount} settled {settledCount === 1 ? "task" : "tasks"}.
                </p>
              </Panel>

              <div className="lg:col-span-2">
                <WithdrawPanel
                  balance={balance}
                  onSent={() => address && usdcBalance(address).then(setBalance).catch(() => {})}
                />
              </div>
            </div>
          )}
        </WalletGate>
      </div>
    </AppShell>
  );
}

/** Withdraw earnings / transfer the escrow asset from the connected wallet to any address. */
function WithdrawPanel({ balance, onSent }: { balance: number | null; onSent: () => void }) {
  const { symbol } = useAsset();
  const { address, signer } = useWallet();
  const { run, loading } = useTx();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  const amountN = parseFloat(amount) || 0;
  const validTo = isAddress(to);
  const overBalance = balance != null && amountN > balance;
  const canSend = validTo && amountN > 0 && !overBalance;

  const send = () =>
    run(
      () => transferUsdc(to as Address, amountN, signer),
      { pending: `Sending ${amountN} ${symbol}…`, success: `${symbol} sent`, onDone: () => { setAmount(""); setTo(""); onSent(); } },
    );

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Send className="h-3.5 w-3.5" /> Withdraw / transfer {symbol}</span>}>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Your agent earnings land in your connected wallet. Move {symbol} out to any address, your own external wallet or someone else's.
      </p>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-mono text-xs text-muted-foreground">Available</span>
        <USDCAmount amount={balance ?? 0} size="sm" className="text-foreground" />
      </div>
      <div className="flex flex-col gap-3">
        <label className="block">
          <div className="field-label mb-1.5">Destination address</div>
          <input className="field" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          {to && !validTo && <div className="font-mono mt-1 text-[11px] text-destructive">Not a valid address.</div>}
        </label>
        <label className="block">
          <div className="field-label mb-1.5 flex items-center justify-between">
            <span>Amount ({symbol})</span>
            {balance != null && (
              <button type="button" onClick={() => setAmount(String(balance))} className="font-mono text-[10px] text-primary hover:text-foreground">MAX</button>
            )}
          </div>
          <input type="number" min="0" className="field" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {overBalance && <div className="font-mono mt-1 text-[11px] text-destructive">Exceeds your balance.</div>}
        </label>
        <button onClick={send} disabled={!canSend || loading || !address} className="tool-btn-primary w-full">
          <Send className="h-3.5 w-3.5" /> {loading ? "Sending…" : `Send ${symbol}`}
        </button>
      </div>
    </Panel>
  );
}
