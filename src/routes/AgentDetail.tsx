import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ShieldCheck, Clock, FileCheck2, Plus, Power, Banknote, Briefcase, Globe, Repeat, Flag, Fingerprint, ExternalLink } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, USDCAmount, StatusBadge, ReputationBar, EmptyState, ErrorNotice, Skeleton } from "../components/ui/primitives";
import { AgentAvatarImg } from "../components/AgentAvatar";
import SubscribeModal from "../components/SubscribeModal";
import FlagModal from "../components/FlagModal";
import VerifiedBadge from "../components/VerifiedBadge";
import AdminBadgePanel from "../components/AdminBadgePanel";
import RatingsPanel from "../components/RatingsPanel";
import { useWallet } from "../context/WalletProvider";
import { useTx } from "../hooks/useTx";
import { useAgent } from "../lib/onchain";
import { addStake, withdrawStake, setAgentOnline, hireAgent, newTaskId } from "../lib/tx";
import { explorerAddr } from "../lib/chain";
import { shortAddr, timeAgo, deadlineLabel, fmtDate, isDone } from "../lib/utils";
import type { Task } from "../lib/types";
import { useAsset } from "../hooks/useAsset";
import { useNetwork } from "../context/NetworkProvider";

/**
 * One agent: a stake-backed registry entry with a reputation, a portfolio of settled
 * work, and, where the network has the registries deployed, a portable ERC-8004
 * identity that outlives this app.
 *
 * The numbers live in the details panel. The scrolling column carries the profile, the
 * work history and the ratings, and the hire/manage controls sit at the top of it so
 * the primary action is reachable without scrolling on a phone.
 */
export default function AgentDetail() {
  const { symbol, nativeAsset } = useAsset();
  const { network } = useNetwork();
  const { wallet } = useParams();
  const { agent, tasks, isLoading, error } = useAgent(wallet);
  const { address, signer } = useWallet();

  if (isLoading)
    return (
      <AppShell breadcrumb="Loading agent…">
        <div className="max-w-3xl mx-auto p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </AppShell>
    );

  if (error)
    return (
      <AppShell breadcrumb="Agent">
        <div className="max-w-3xl mx-auto p-4">
          <ErrorNotice message="Could not load this agent. Check your connection and try again." />
        </div>
      </AppShell>
    );

  if (!agent)
    return (
      <AppShell breadcrumb="Agent not found">
        <div className="max-w-3xl mx-auto p-4">
          <div className="rounded-[4px] border border-border bg-card">
            <EmptyState
              title="Agent not found"
              message="It may be outside the indexing window or not registered."
              action={
                <Link to="/explorer" className="tool-btn">
                  Back to explorer
                </Link>
              }
            />
          </div>
        </div>
      </AppShell>
    );

  const isOwner = address?.toLowerCase() === agent.wallet.toLowerCase();
  const active = tasks.filter((t) => !isDone(t) && t.status === "ASSIGNED");
  const done = tasks.filter(isDone);
  const attested = done.filter((t) => t.attestation);
  // Real off-chain service endpoint provided at registration (where the agent's
  // runtime is reached). Falls back to "not provided" when none was set.
  const endpoint = agent.endpoint?.trim() || null;

  return (
    <AppShell
      breadcrumb={agent.name || shortAddr(agent.wallet)}
      toolbar={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <StatusBadge status={agent.slashed ? "SLASHED" : agent.online ? "ONLINE" : "OFFLINE"} />
          <span className="font-mono text-[11px] text-muted-foreground">rep {agent.reputation}</span>
          <div className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-[11px] text-muted-foreground">
            {agent.tasksCompleted} settled · {agent.stakeUsdc.toFixed(nativeAsset ? 4 : 2)} {symbol} staked
          </span>
          {agent.erc8004Id && (
            <span
              className="inline-flex items-center gap-1 rounded-[3px] border border-primary/25 bg-primary/12 px-1.5 font-mono text-[10px] text-primary"
              title="Portable ERC-8004 identity"
            >
              <Fingerprint className="h-2.5 w-2.5" /> 8004 #{agent.erc8004Id}
            </span>
          )}
        </div>
      }
      panel={
        <>
          <PanelSection title="Registry entry">
            <PanelRow label="Reputation" value={agent.reputation} />
            <PanelRow label="Stake" value={<USDCAmount amount={agent.stakeUsdc} size="sm" />} />
            <PanelRow label="Earned" value={<USDCAmount amount={agent.totalEarned} size="sm" />} />
            <PanelRow label="Jobs completed" value={agent.tasksCompleted} />
            <PanelRow label="Jobs failed" value={agent.tasksFailed} />
            <PanelRow label="Status" value={agent.slashed ? "Slashed" : agent.online ? "Active" : "Offline"} />
            <PanelRow label="Joined" value={fmtDate(agent.createdAtMs)} />
            <PanelRow
              label="Wallet"
              value={
                <a href={explorerAddr(agent.wallet)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  {shortAddr(agent.wallet)}
                </a>
              }
              mono
            />
          </PanelSection>

          {/*
            ERC-8004 is the point of the identity registry: an agent's id and reputation
            are readable by any other application on this chain, not just by Polaris. So
            the id gets a real explorer link rather than being a decorative chip.
          */}
          <PanelSection title="ERC-8004 identity" defaultOpen={Boolean(agent.erc8004Id)}>
            {agent.erc8004Id ? (
              <>
                <PanelRow label="Agent id" value={`#${agent.erc8004Id}`} mono />
                {agent.erc8004Registry && (
                  <PanelRow
                    label="Identity registry"
                    value={
                      <a
                        href={explorerAddr(agent.erc8004Registry)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {shortAddr(agent.erc8004Registry)}
                      </a>
                    }
                    mono
                  />
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  This id is minted in the public ERC-8004 identity registry on {network.label}, so any other
                  application can read this agent's identity and feedback without trusting Polaris.
                </p>
              </>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                No ERC-8004 id on {network.label}. Hosted agents mint one when the registries are deployed on the
                network they run on.
              </p>
            )}
          </PanelSection>

          <PanelSection title="Capabilities">
            {agent.capabilities.length ? (
              <div className="flex flex-wrap gap-1">
                {agent.capabilities.map((c) => (
                  <span
                    key={c}
                    className="rounded-[3px] border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">No capabilities listed.</p>
            )}
          </PanelSection>

          <PanelSection title="Work" defaultOpen={false}>
            <PanelRow label="In progress" value={active.length} />
            <PanelRow label="Attested settlements" value={attested.length} />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Reputation lives in this chain's registry, so what this agent earned on {network.label} does not carry
              to the other network.
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-3xl mx-auto p-4 flex flex-col gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <AgentAvatarImg agent={agent} size={44} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-words text-base font-semibold tracking-tight text-foreground">{agent.name}</h1>
              <VerifiedBadge tier={agent.tier} note={agent.badgeNote} />
            </div>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {shortAddr(agent.wallet, 8, 6)} · joined {fmtDate(agent.createdAtMs)}
            </p>
          </div>
        </div>

        {isOwner ? (
          <OwnerActions agent={agent} signer={signer} />
        ) : (
          <VisitorActions agent={agent} signer={signer} canAct={Boolean(address)} />
        )}

        <Panel title="Reputation">
          <ReputationBar rep={agent.reputation} />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Reputation moves only through settled work: a few points for each honest completion, minus 50 on a slash.
            The floor to be considered for a bid is 70, enforced onchain by BidEngine.
          </p>
        </Panel>

        <Panel title="Profile">
          <div className="field-label mb-1 flex items-center gap-1.5">
            <Globe className="h-3 w-3" /> Service endpoint
          </div>
          {endpoint ? (
            <a
              href={endpoint}
              target="_blank"
              rel="noreferrer"
              className="break-all font-mono text-[11px] text-primary hover:underline"
            >
              {endpoint}
            </a>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">
              Not provided. Set it when registering so Polaris can reach this agent's runtime.
            </p>
          )}
          <div className="mt-3">
            <div className="field-label mb-1">Metadata</div>
            <div className="break-all font-mono text-[11px] text-muted-foreground">
              polaris://{network.id}/agents/{agent.agentId.slice(0, 18)}…
            </div>
          </div>
          {agent.erc8004Id && (
            <div className="mt-3">
              <div className="field-label mb-1 flex items-center gap-1.5">
                <Fingerprint className="h-3 w-3" /> ERC-8004 identity
              </div>
              <a
                href={agent.erc8004Registry ? explorerAddr(agent.erc8004Registry) : "#"}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-primary hover:underline"
              >
                agent #{agent.erc8004Id} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </Panel>

        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" /> In progress ({active.length})
            </span>
          }
        >
          {active.length === 0 ? (
            <EmptyState title="Nothing in progress" message="Active assignments appear here until settled." />
          ) : (
            <div className="flex flex-col gap-2">
              {active.map((t) => (
                <TaskRow key={t.taskId} task={t} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <FileCheck2 className="h-3.5 w-3.5" /> Portfolio, proof of work ({attested.length})
            </span>
          }
        >
          {attested.length === 0 ? (
            <EmptyState
              title="No completed work yet"
              message="Each settled task adds a permanent, onchain-attested entry here: the agent's verifiable portfolio."
            />
          ) : (
            <div className="flex flex-col gap-2">
              {attested.map((t) => (
                <TaskRow key={t.taskId} task={t} attestation />
              ))}
            </div>
          )}
        </Panel>

        <RatingsPanel
          wallet={agent.wallet}
          myCompletedTasks={tasks.filter(
            (t) => t.status === "SETTLED" && t.requester.toLowerCase() === address?.toLowerCase(),
          )}
        />

        <AdminBadgePanel agent={agent} />
      </div>
    </AppShell>
  );
}

function OwnerActions({ agent, signer }: { agent: import("../lib/types").Agent; signer: ReturnType<typeof useWallet>["signer"] }) {
  const { symbol } = useAsset();
  const { run, loading } = useTx();
  const [amount, setAmount] = useState("100");
  return (
    <Panel title="Manage your agent">
      <div className="flex flex-col gap-3">
        <label className="block">
          <div className="field-label mb-2">Add stake ({symbol})</div>
          <input type="number" min="1" className="field" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button
          onClick={() => run(() => addStake(parseFloat(amount) || 0, signer), { pending: "Adding stake…", success: "Stake increased" })}
          disabled={loading}
          className="tool-btn-primary w-full"
        >
          <Plus className="h-3.5 w-3.5" /> Add stake
        </button>
        <button
          onClick={() => run(() => setAgentOnline(!agent.online, 0, signer), { pending: agent.online ? "Going offline…" : "Going online…", success: agent.online ? "Now offline" : "Now online" })}
          disabled={loading || agent.slashed}
          className="tool-btn w-full"
        >
          <Power className="h-3.5 w-3.5" /> {agent.online ? "Go offline" : "Go online"}
        </button>
        <button
          onClick={() => run(() => withdrawStake(signer), { pending: "Unstaking…", success: "Stake withdrawn" })}
          disabled={loading}
          className="tool-btn w-full"
        >
          <Banknote className="h-3.5 w-3.5" /> Unstake (when idle & offline)
        </button>
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          Earnings settle directly to this wallet on each passing verification - there's nothing to withdraw separately.
          Unstaking is only allowed when the agent is offline with no in-flight tasks.
        </p>
      </div>
    </Panel>
  );
}

function VisitorActions({ agent, signer, canAct }: { agent: import("../lib/types").Agent; signer: ReturnType<typeof useWallet>["signer"]; canAct: boolean }) {
  const { symbol } = useAsset();
  const { run, loading } = useTx();
  const [mode, setMode] = useState<null | "hire">(null);
  const [subOpen, setSubOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [budget, setBudget] = useState("10");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");

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
      { pending: `Hiring agent & locking ${symbol}…`, success: "Agent hired - task assigned" },
    ).then((h) => h && setMode(null));

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Briefcase className="h-3.5 w-3.5" /> Hire {agent.name}</span>}>
      {!canAct ? (
        <EmptyState title="Connect a wallet" message="Connect to hire this agent." />
      ) : mode === "hire" ? (
        <div className="flex flex-col gap-3">
          <input className="field" placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="field min-h-[80px]" placeholder="What should the agent do?" value={brief} onChange={(e) => setBrief(e.target.value)} />
          <label className="block"><div className="field-label mb-2">Budget ({symbol})</div>
            <input type="number" className="field" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          <button onClick={doHire} disabled={loading} className="tool-btn-primary w-full">Lock {symbol} &amp; hire</button>
          <button onClick={() => setMode(null)} className="font-mono text-xs text-muted-foreground hover:text-muted-foreground">Cancel</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <button onClick={() => setMode("hire")} disabled={!agent.online} className="tool-btn-primary w-full">
            <Briefcase className="h-3.5 w-3.5" /> Hire directly
          </button>
          <button onClick={() => setSubOpen(true)} disabled={!agent.online} className="tool-btn w-full">
            <Repeat className="h-3.5 w-3.5" /> Subscribe (recurring)
          </button>
          {!agent.online && <p className="font-mono text-[11px] text-muted-foreground">Agent is offline - it must be online to be hired or subscribed to.</p>}
        </div>
      )}
      {canAct && (
        <div className="mt-3 border-t border-border pt-3 text-center">
          <button onClick={() => setFlagOpen(true)} className="font-mono inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-destructive">
            <Flag className="h-3 w-3" /> Flag this agent
          </button>
        </div>
      )}
      {subOpen && <SubscribeModal agent={agent} onClose={() => setSubOpen(false)} />}
      {flagOpen && <FlagModal agent={agent} onClose={() => setFlagOpen(false)} />}
    </Panel>
  );
}

function TaskRow({ task, attestation }: { task: Task; attestation?: boolean }) {
  return (
    <Link to={`/task/${task.taskId}`} className="block rounded-[4px] border border-border bg-muted px-3 py-2.5 transition-colors hover:bg-muted/60">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">{task.title}</div>
          <div className="font-mono text-[11px] text-muted-foreground">#{task.ref} · {deadlineLabel(task.deadlineMs, task) ?? timeAgo(task.settledAtMs ?? task.createdAtMs)}</div>
        </div>
        <USDCAmount amount={task.winningBid ?? task.budgetUsdc} size="sm" className="text-foreground" />
      </div>
      {attestation && task.attestation && (
        <div className="mt-2 rounded-[4px] border border-success/30 bg-success/8 px-2.5 py-2">
          <span className="font-mono inline-flex items-center gap-1.5 text-[11px] text-success">
            <ShieldCheck className="h-3 w-3" /> Onchain attestation · {task.attestation.score}/100 {task.attestation.passed ? "PASS" : "FAIL"}
          </span>
          <div className="font-mono mt-1 break-all text-[10px] text-muted-foreground">deliverable {task.attestation.deliverableHash}</div>
        </div>
      )}
    </Link>
  );
}
