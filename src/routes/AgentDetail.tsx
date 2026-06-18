import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ShieldCheck, Clock, FileCheck2, Plus, Power, Banknote, Send, Briefcase } from "lucide-react";
import { Panel, StatCard, USDCAmount, StatusBadge, ReputationBar, EmptyState, Skeleton } from "../components/ui/primitives";
import { AgentAvatarImg } from "../components/AgentAvatar";
import { useWallet } from "../context/WalletProvider";
import { useTx } from "../hooks/useTx";
import { useAgent } from "../lib/onchain";
import { addStake, withdrawStake, setAgentOnline, hireAgent, wireUsdc, newTaskId } from "../lib/tx";
import { explorerAddr } from "../lib/chain";
import { shortAddr, timeAgo, deadlineLabel } from "../lib/utils";
import type { Task } from "../lib/types";

/**
 * Agent detail - a stake-backed onchain registry entry: identity, reputation,
 * stake/earnings, onchain status, capabilities, and the agent's task history
 * with onchain settlement attestations. Owners get stake/online controls;
 * everyone else can hire the agent directly or wire it USDC.
 */
export default function AgentDetail() {
  const { wallet } = useParams();
  const { agent, tasks, isLoading } = useAgent(wallet);
  const { address, signer } = useWallet();

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!agent)
    return (
      <div className="panel">
        <EmptyState
          title="Agent not found"
          message="It may be outside the indexing window or not registered."
          action={<Link to="/explorer" className="btn-ghost">Back to explorer</Link>}
        />
      </div>
    );

  const isOwner = address?.toLowerCase() === agent.wallet.toLowerCase();
  const active = tasks.filter((t) => t.status === "ASSIGNED" || t.status === "IN_PROGRESS");
  const done = tasks.filter((t) => t.status === "SETTLED");
  const attested = done.filter((t) => t.attestation);
  const endpoint = `https://agents.polaris.app/${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <div>
      <Link to="/explorer" className="mono mb-5 inline-flex items-center gap-1.5 text-xs text-grey hover:text-grey-l">
        <ArrowLeft size={14} /> Back to explorer
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <AgentAvatarImg agent={agent} size={64} />
          <div>
            <div className="eyebrow mb-1">{agent.capabilities[0] ?? "Agent"}</div>
            <h1 className="text-3xl font-bold tracking-tightest text-white">{agent.name}</h1>
            <div className="mono mt-1 text-xs text-grey">
              agent{" "}
              <a href={explorerAddr(agent.wallet)} target="_blank" rel="noreferrer" className="text-blue-l hover:underline">
                {shortAddr(agent.wallet, 8, 6)}
              </a>
            </div>
          </div>
        </div>
        <StatusBadge status={agent.slashed ? "SLASHED" : agent.online ? "ONLINE" : "OFFLINE"} />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Reputation" value={agent.reputation} accent="violet" />
        <StatCard label="Stake" value={<USDCAmount amount={agent.stakeUsdc} size="lg" />} accent="usdc" />
        <StatCard label="Earned" value={<USDCAmount amount={agent.totalEarned} size="lg" />} accent="green" />
        <StatCard label="Jobs Completed" value={agent.tasksCompleted} accent="blue" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="order-2 flex flex-col gap-6 lg:order-1">
          {/* Onchain status */}
          <Panel title="Onchain status">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Jobs completed" value={String(agent.tasksCompleted)} />
              <Field label="Jobs failed" value={String(agent.tasksFailed)} />
              <Field label="Registry status" value={agent.slashed ? "Slashed" : agent.online ? "Active" : "Offline"} />
              <Field label="Stake" value={`${agent.stakeUsdc.toFixed(2)} USDC`} />
            </div>
            <div className="mt-4"><ReputationBar rep={agent.reputation} /></div>
            <p className="mt-4 text-xs leading-relaxed text-grey-l">
              This agent is a stake-backed onchain registry entry. Its reputation and settlement history are tied to its
              wallet address on Arc.
            </p>
          </Panel>

          {/* Capabilities / endpoint / metadata */}
          <Panel title="Profile">
            <div className="eyebrow mb-2">Capabilities</div>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {agent.capabilities.length ? (
                agent.capabilities.map((c) => (
                  <span key={c} className="mono rounded-md border border-border bg-deep px-2 py-0.5 text-[11px] text-grey-l">{c}</span>
                ))
              ) : (
                <span className="text-xs text-grey">No capabilities listed.</span>
              )}
            </div>
            <Field label="Endpoint" value={endpoint} mono />
            <div className="mt-3"><Field label="Metadata" value={`arc://agents/${agent.agentId.slice(0, 18)}…`} mono /></div>
          </Panel>

          {/* Task history */}
          <Panel title={<span className="inline-flex items-center gap-2"><Clock size={13} /> In progress ({active.length})</span>}>
            {active.length === 0 ? (
              <EmptyState title="Nothing in progress" message="Active assignments appear here until settled." />
            ) : (
              <div className="flex flex-col gap-3">{active.map((t) => <TaskRow key={t.taskId} task={t} />)}</div>
            )}
          </Panel>

          <Panel title={<span className="inline-flex items-center gap-2"><FileCheck2 size={13} /> Recent attestations ({attested.length})</span>}>
            {attested.length === 0 ? (
              <EmptyState title="No attestations yet" message="Settled work + onchain attestations appear here once this agent wins a task." />
            ) : (
              <div className="flex flex-col gap-3">{attested.map((t) => <TaskRow key={t.taskId} task={t} attestation />)}</div>
            )}
          </Panel>
        </div>

        {/* Action rail - first on mobile so Hire/Manage is immediately visible */}
        <div className="order-1 flex flex-col gap-6 lg:order-2">
          {isOwner ? (
            <OwnerActions agent={agent} signer={signer} />
          ) : (
            <VisitorActions agent={agent} signer={signer} canAct={Boolean(address)} />
          )}
        </div>
      </div>
    </div>
  );
}

function OwnerActions({ agent, signer }: { agent: import("../lib/types").Agent; signer: ReturnType<typeof useWallet>["signer"] }) {
  const { run, loading } = useTx();
  const [amount, setAmount] = useState("100");
  return (
    <Panel title="Manage your agent">
      <div className="flex flex-col gap-3">
        <label className="block">
          <div className="eyebrow mb-2">Add stake (USDC)</div>
          <input type="number" min="1" className="input-field" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button
          onClick={() => run(() => addStake(parseFloat(amount) || 0, signer), { pending: "Adding stake…", success: "Stake increased" })}
          disabled={loading}
          className="btn-primary w-full"
        >
          <Plus size={15} /> Add stake
        </button>
        <button
          onClick={() => run(() => setAgentOnline(!agent.online, 0, signer), { pending: agent.online ? "Going offline…" : "Going online…", success: agent.online ? "Now offline" : "Now online" })}
          disabled={loading || agent.slashed}
          className="btn-ghost w-full"
        >
          <Power size={15} /> {agent.online ? "Go offline" : "Go online"}
        </button>
        <button
          onClick={() => run(() => withdrawStake(signer), { pending: "Unstaking…", success: "Stake withdrawn" })}
          disabled={loading}
          className="btn-ghost w-full"
        >
          <Banknote size={15} /> Unstake (when idle & offline)
        </button>
        <p className="mono text-[11px] leading-relaxed text-grey">
          Earnings settle directly to this wallet on each passing verification - there's nothing to withdraw separately.
          Unstaking is only allowed when the agent is offline with no in-flight tasks.
        </p>
      </div>
    </Panel>
  );
}

function VisitorActions({ agent, signer, canAct }: { agent: import("../lib/types").Agent; signer: ReturnType<typeof useWallet>["signer"]; canAct: boolean }) {
  const { run, loading } = useTx();
  const [mode, setMode] = useState<null | "hire" | "wire">(null);
  const [budget, setBudget] = useState("10");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [wireAmt, setWireAmt] = useState("5");

  const doHire = () =>
    run(
      () =>
        hireAgent(
          {
            agent: agent.wallet,
            taskId: newTaskId(),
            budgetUsdc: parseFloat(budget) || 0,
            deadlineMs: Date.now() + 3 * 86400_000,
            title: title.trim() || `Direct task for ${agent.name}`,
            description: brief.trim() || title.trim(),
            rubric: "Deliver the requested work accurately, clearly, and on time.",
            taskType: agent.capabilities[0] ?? "general",
          },
          signer,
        ),
      { pending: "Hiring agent & locking USDC…", success: "Agent hired - task assigned" },
    ).then((h) => h && setMode(null));

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Briefcase size={14} /> Hire {agent.name}</span>}>
      {!canAct ? (
        <EmptyState title="Connect a wallet" message="Connect to hire this agent or wire it USDC." />
      ) : mode === "hire" ? (
        <div className="flex flex-col gap-3">
          <input className="input-field" placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="input-field min-h-[80px]" placeholder="What should the agent do?" value={brief} onChange={(e) => setBrief(e.target.value)} />
          <label className="block"><div className="eyebrow mb-2">Budget (USDC)</div>
            <input type="number" className="input-field" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          <button onClick={doHire} disabled={loading} className="btn-primary w-full">Lock USDC & hire</button>
          <button onClick={() => setMode(null)} className="mono text-xs text-grey hover:text-grey-l">Cancel</button>
        </div>
      ) : mode === "wire" ? (
        <div className="flex flex-col gap-3">
          <label className="block"><div className="eyebrow mb-2">Amount (USDC)</div>
            <input type="number" className="input-field" value={wireAmt} onChange={(e) => setWireAmt(e.target.value)} /></label>
          <button
            onClick={() => run(() => wireUsdc(agent.wallet, parseFloat(wireAmt) || 0, signer), { pending: "Wiring USDC…", success: "USDC sent" }).then((h) => h && setMode(null))}
            disabled={loading}
            className="btn-primary w-full"
          >
            Wire {wireAmt} USDC
          </button>
          <button onClick={() => setMode(null)} className="mono text-xs text-grey hover:text-grey-l">Cancel</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <button onClick={() => setMode("hire")} disabled={!agent.online} className="btn-primary w-full">
            <Briefcase size={15} /> Hire directly
          </button>
          <button onClick={() => setMode("wire")} className="btn-ghost w-full">
            <Send size={15} /> Wire USDC
          </button>
          {!agent.online && <p className="mono text-[11px] text-grey">Agent is offline - it must be online to be hired.</p>}
        </div>
      )}
    </Panel>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="eyebrow mb-1">{label}</div>
      <div className={`${mono ? "mono break-all text-[11px]" : "text-sm"} text-grey-l`}>{value}</div>
    </div>
  );
}

function TaskRow({ task, attestation }: { task: Task; attestation?: boolean }) {
  return (
    <Link to={`/task/${task.taskId}`} className="block rounded-xl border border-border bg-deep p-4 transition-colors hover:border-border2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">{task.title}</div>
          <div className="mono text-[11px] text-grey">#{task.ref} · {task.status === "SETTLED" ? timeAgo(task.createdAtMs) : deadlineLabel(task.deadlineMs)}</div>
        </div>
        <USDCAmount amount={task.winningBid ?? task.budgetUsdc} size="sm" className="text-white" />
      </div>
      {attestation && task.attestation && (
        <div className="mt-3 rounded-lg border border-green/30 bg-green/5 p-2.5">
          <span className="mono inline-flex items-center gap-1.5 text-[11px] text-green">
            <ShieldCheck size={12} /> Onchain attestation · {task.attestation.score}/100 {task.attestation.passed ? "PASS" : "FAIL"}
          </span>
          <div className="mono mt-1 break-all text-[10px] text-grey">deliverable {task.attestation.deliverableHash}</div>
        </div>
      )}
    </Link>
  );
}
