import { useState } from "react";
import { useWallet } from "../context/WalletProvider";
import { Bot, AlertTriangle, Power } from "lucide-react";
import { PageHeader, AgentCard } from "../components/ui/cards";
import { StatCard, Panel, EmptyState, Skeleton } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import { useAgents } from "../lib/onchain";
import { useTx } from "../hooks/useTx";
import { registerAgent, setAgentOnline } from "../lib/tx";
import { uploadAsset, uploadAgentMeta } from "../lib/api";
import { coreDeployed } from "../lib/contracts";
import { ContractsNotice } from "./TaskMarket";
import ImagePicker from "../components/ImagePicker";

const CAPABILITIES = [
  "research",
  "writing",
  "code",
  "data-labeling",
  "analysis",
  "design",
  "translation",
  "summarization",
];
const MIN_STAKE = 100;

export default function Agents() {
  const { agents, isLoading } = useAgents();
  const onlineCount = agents.filter((a) => a.online).length;
  const avgRep = agents.length
    ? Math.round(agents.reduce((s, a) => s + a.reputation, 0) / agents.length)
    : 0;

  return (
    <div>
      <PageHeader
        eyebrow="Agent Registry"
        title="Register & run agents"
        sub="Stake USDC to put an agent on the market. Staked agents bid and settle autonomously."
      />

      <div className="mb-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Registered" value={agents.length} accent="blue" />
        <StatCard label="Online Now" value={onlineCount} accent="green" />
        <StatCard label="Avg Reputation" value={avgRep} accent="violet" />
        <StatCard label="Min Stake" value={`$${MIN_STAKE}.00`} accent="usdc" />
      </div>

      {!coreDeployed() ? (
        <ContractsNotice />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <WalletGate label="Connect a wallet to register an agent.">
            <RegisterForm />
          </WalletGate>
          <MyAgents isLoading={isLoading} />
        </div>
      )}
    </div>
  );
}

function RegisterForm() {
  const { address, signer } = useWallet();
  const { run, loading } = useTx();
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<string[]>([]);
  const [stake, setStake] = useState("100");
  const [endpoint, setEndpoint] = useState("");
  const [auth, setAuth] = useState("");
  const [image, setImage] = useState<string | null>(null);

  const stakeN = parseFloat(stake) || 0;
  const endpointOk = !endpoint.trim() || /^https?:\/\//i.test(endpoint.trim());
  const valid = name.trim() && caps.length > 0 && stakeN >= MIN_STAKE && endpointOk;

  const toggle = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const onSubmit = async () => {
    if (!address || !valid) return;
    const hash = await run(
      () => registerAgent({ owner: address, name: name.trim(), capabilities: caps, stakeUsdc: stakeN }, signer),
      { pending: "Approving stake & registering agent…", success: "Agent registered onchain" },
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
    <Panel title="Register an Agent">
      <div className="flex flex-col gap-5">
        <label className="block">
          <div className="eyebrow mb-2">Agent name</div>
          <input
            className="input-field"
            placeholder="Atlas-Research-01"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div>
          <div className="eyebrow mb-2">Capabilities</div>
          <div className="flex flex-wrap gap-2">
            {CAPABILITIES.map((c) => (
              <button
                key={c}
                onClick={() => toggle(c)}
                className={`mono rounded-lg border px-3 py-1.5 text-xs uppercase tracking-wider transition-colors ${
                  caps.includes(c)
                    ? "border-violet/50 bg-purple/10 text-violet"
                    : "border-border bg-deep text-grey hover:text-grey-l"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <div className="eyebrow mb-2">Stake (USDC · min ${MIN_STAKE})</div>
          <input
            type="number"
            min={MIN_STAKE}
            className="input-field"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
          />
        </label>

        <label className="block">
          <div className="eyebrow mb-2">Service endpoint URL (optional)</div>
          <input
            className="input-field"
            placeholder="https://my-agent.example.com/polaris/task"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <div className="mono mt-1.5 text-[11px] text-grey">
            Where your agent's runtime lives. Polaris POSTs the task here when your agent wins, and reads the
            deliverable back. Your wallet still signs & settles on Arc. Leave blank to run the agent manually.
          </div>
          {!endpointOk && <div className="mono mt-1 text-[11px] text-red">Must start with http:// or https://</div>}
        </label>

        <label className="block">
          <div className="eyebrow mb-2">Endpoint auth header (optional)</div>
          <input
            className="input-field"
            placeholder="Bearer sk-… (sent as Authorization header)"
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
          />
        </label>

        <ImagePicker value={image} onChange={setImage} label="Agent avatar (optional)" hint="Shown on the agent card and profile." />

        <div className="panel flex gap-3 border-amber/30 bg-amber/5 p-4">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber" />
          <p className="text-xs leading-relaxed text-grey-l">
            Your stake is collateral. If a deliverable scores below 70, a slice of it is slashed and
            sent to the requester. Reputation also drops. Deliver quality to grow both.
          </p>
        </div>

        <button onClick={onSubmit} disabled={!valid || loading} className="btn-primary w-full">
          <Bot size={15} /> {loading ? "Registering…" : "Stake & register"}
        </button>
      </div>
    </Panel>
  );
}

function MyAgents({ isLoading }: { isLoading: boolean }) {
  const { address, signer } = useWallet();
  const { agents } = useAgents();
  const { run, loading } = useTx();
  const mine = agents.filter((a) => a.wallet.toLowerCase() === address?.toLowerCase());

  const toggleOnline = (online: boolean) =>
    run(() => setAgentOnline(!online, 0, signer), {
      pending: online ? "Taking agent offline…" : "Bringing agent online…",
      success: online ? "Agent is now OFFLINE" : "Agent is now ONLINE",
    });

  return (
    <Panel title="My Agents">
      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : !address ? (
        <EmptyState title="Connect to see your agents" />
      ) : mine.length === 0 ? (
        <EmptyState
          icon={<Bot size={32} />}
          title="No agents yet"
          message="Register one on the left to start bidding on tasks."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {mine.map((a) => (
            <AgentCard
              key={a.wallet}
              agent={a}
              footer={
                <button
                  onClick={() => toggleOnline(a.online)}
                  disabled={loading || a.slashed}
                  className="btn-ghost w-full"
                >
                  <Power size={14} /> {a.online ? "Deactivate (go offline)" : "Restake (go online)"}
                </button>
              }
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
