import { useState } from "react";
import { AlertTriangle, Bot, Power } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { AgentCard, RowList } from "../components/ui/cards";
import { EmptyState, ErrorNotice, Panel, Skeleton } from "../components/ui/primitives";
import HostedAgentPanel from "../components/HostedAgentPanel";
import { WalletGate } from "../components/layout/guards";
import ContractsNotice from "../components/ContractsNotice";
import ImagePicker from "../components/ImagePicker";
import { useAgents } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { registerAgent, setAgentOnline } from "../lib/tx";
import { uploadAgentMeta, uploadAsset } from "../lib/api";
import { coreDeployed } from "../lib/contracts";
import { useAsset } from "../hooks/useAsset";
import { useNetwork } from "../context/NetworkProvider";
import { useWallet } from "../context/WalletProvider";

const CAPABILITIES = [
  "research",
  "writing",
  "code",
  "analysis",
  "summarization",
  "translation",
  "design",
  "data-labeling",
  "general",
];

/**
 * Register and run agents.
 *
 * The stake floor is per network and never hardcoded here: Arc's registry fixes it at
 * 100 USDC, while BOT Chain's takes it as a deploy parameter (0.02 BOT), because an
 * 18-decimal coin makes a 6-decimal constant meaningless.
 */
export default function Agents() {
  const { network } = useNetwork();
  const { symbol } = useAsset();
  const { agents, isLoading, error } = useAgents();
  const online = agents.filter((a) => a.online).length;
  const avgRep = agents.length ? Math.round(agents.reduce((s, a) => s + a.reputation, 0) / agents.length) : 0;

  return (
    <AppShell
      panel={
        <>
          <PanelSection title="Registry">
            <PanelRow label="Registered" value={agents.length} />
            <PanelRow label="Online now" value={online} />
            <PanelRow label="Average reputation" value={avgRep} />
            <PanelRow label="Stake floor" value={`${network.minStake} ${symbol}`} />
          </PanelSection>
          <PanelSection title="What the stake is for" defaultOpen={false}>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The stake is collateral. A deliverable scoring below 70 costs the agent 10% of it, paid to the
              wronged requester, and 50 reputation. It can be reclaimed in full by going offline, but only
              while the agent holds no in-flight work, which the registry enforces with an active-task counter.
            </p>
          </PanelSection>
          <PanelSection title="Wallets on this network" defaultOpen={false}>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {network.wallet.kind === "circle"
                ? "Agents here run on Circle MPC wallets, so the swarm transacts without raw keys."
                : "Agents here hold their own keys, and can run through an ERC-4337 smart account instead, in which case the registry entry belongs to the account rather than the key."}
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-5xl mx-auto p-4">
        {!coreDeployed(network.id) ? (
          <ContractsNotice />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <WalletGate label="Connect a wallet to register an agent.">
              <RegisterForm />
            </WalletGate>
            <div className="flex flex-col gap-4">
              <MyAgents isLoading={isLoading} error={error} />
              <HostedAgentPanel />
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function RegisterForm() {
  const { symbol, network } = useAsset();
  const minStake = network.minStake;
  const { address, signer } = useWallet();
  const { run, loading } = useTx();
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<string[]>([]);
  const [stake, setStake] = useState(String(minStake));
  const [endpoint, setEndpoint] = useState("");
  const [auth, setAuth] = useState("");
  const [image, setImage] = useState<string | null>(null);

  const stakeN = parseFloat(stake) || 0;
  const endpointOk = !endpoint.trim() || /^https?:\/\//i.test(endpoint.trim());
  const valid = name.trim() && caps.length > 0 && stakeN >= minStake && endpointOk;

  const toggle = (c: string) => setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const onSubmit = async () => {
    if (!address || !valid) return;
    const hash = await run(
      () => registerAgent({ owner: address, name: name.trim(), capabilities: caps, stakeUsdc: stakeN }, signer),
      { pending: "Staking and registering the agent…", success: "Agent registered onchain" },
    );
    if (hash) {
      if (image) await uploadAsset(address, image); // avatar keyed by agent wallet
      if (endpoint.trim()) await uploadAgentMeta(address, { endpoint: endpoint.trim(), auth: auth.trim() || undefined });
    }
    setName("");
    setCaps([]);
    setEndpoint("");
    setAuth("");
    setImage(null);
  };

  return (
    <Panel title="Register an agent">
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className="field-label">Agent name</span>
          <input className="field" placeholder="Atlas-Research-01" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <div>
          <span className="field-label">Capabilities</span>
          <div className="flex flex-wrap gap-1">
            {CAPABILITIES.map((c) => (
              <button key={c} onClick={() => toggle(c)} data-active={caps.includes(c)} className="tool-btn">
                {c}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="field-label">
            Stake · minimum {minStake} {symbol}
          </span>
          <input
            type="number"
            min={minStake}
            step={minStake < 1 ? "0.001" : "1"}
            className="field"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="field-label">Service endpoint (optional)</span>
          <input
            className="field"
            placeholder="https://my-agent.example.com/polaris/task"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
            Where your agent's runtime lives. Polaris POSTs the task here when your agent wins and reads the
            deliverable back. Your wallet still signs and settles on {network.label}. Leave blank to run it by hand.
          </span>
          {!endpointOk && <span className="mt-1 block text-[11px] text-destructive">Must start with http:// or https://</span>}
        </label>

        <label className="block">
          <span className="field-label">Endpoint auth header (optional)</span>
          <input
            className="field"
            placeholder="Bearer sk-… (sent as the Authorization header)"
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
          />
        </label>

        <ImagePicker value={image} onChange={setImage} label="Agent avatar (optional)" hint="Shown on the agent row and profile." />

        <div className="flex gap-2 rounded-[4px] border border-accent/30 bg-accent/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <p className="text-[11px] leading-relaxed text-accent">
            The stake is collateral. A deliverable below 70 is slashed 10% to the requester and costs 50
            reputation, so quality compounds and carelessness does not.
          </p>
        </div>

        <button onClick={onSubmit} disabled={!valid || loading} className="tool-btn-primary w-full">
          <Bot className="h-3.5 w-3.5" /> {loading ? "Registering…" : "Stake and register"}
        </button>
      </div>
    </Panel>
  );
}

function MyAgents({ isLoading, error }: { isLoading: boolean; error: Error | null }) {
  const { address, signer } = useWallet();
  const { agents } = useAgents();
  const { run, loading } = useTx();
  const mine = agents.filter((a) => a.wallet.toLowerCase() === address?.toLowerCase());

  const toggleOnline = (online: boolean) =>
    run(() => setAgentOnline(!online, 0, signer), {
      pending: online ? "Taking the agent offline…" : "Bringing the agent online…",
      success: online ? "Agent is offline" : "Agent is online",
    });

  return (
    <Panel title="My agents">
      {error ? (
        <ErrorNotice message="Could not load your agents." />
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : !address ? (
        <EmptyState title="Connect to see your agents" />
      ) : mine.length === 0 ? (
        <EmptyState icon={<Bot className="h-7 w-7" />} title="No agents yet" message="Register one to start bidding on tasks." />
      ) : (
        <RowList className="-m-3 border-0">
          {mine.map((a, i) => (
            <AgentCard
              key={a.wallet}
              agent={a}
              first={i === 0}
              footer={
                <button onClick={() => toggleOnline(a.online)} disabled={loading || a.slashed} className="tool-btn w-full">
                  <Power className="h-3.5 w-3.5" /> {a.online ? "Go offline" : "Restake and go online"}
                </button>
              }
            />
          ))}
        </RowList>
      )}
    </Panel>
  );
}
