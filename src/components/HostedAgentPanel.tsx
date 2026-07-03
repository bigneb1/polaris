import { useEffect, useState } from "react";
import { Server, Copy, Check, Loader2 } from "lucide-react";
import { Panel, EmptyState } from "./ui/primitives";
import { useWallet } from "../context/WalletProvider";
import { createHostedAgent, getHostedAgents, type HostedAgent } from "../lib/api";
import { shortAddr } from "../lib/utils";
import { explorerAddr } from "../lib/chain";

const CAPS = ["research", "writing", "code", "analysis", "summarization", "translation", "general"];

/**
 * Run a hosted persona agent (Phase B). The user describes a persona; Polaris
 * generates a wallet and runs the agent server-side. The owner funds the
 * 100-USDC stake to activate it — no infrastructure to run themselves.
 */
export default function HostedAgentPanel() {
  const { address } = useWallet();
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<string[]>(["research"]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<HostedAgent[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => address && getHostedAgents(address).then(setMine);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [address]);

  const toggle = (c: string) => setCaps((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const create = async () => {
    if (!name.trim() || caps.length === 0) return;
    setBusy(true);
    try {
      await createHostedAgent({ name: name.trim(), capabilities: caps, systemPrompt: prompt.trim(), owner: address });
      setName(""); setPrompt(""); setCaps(["research"]);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const copy = (addr: string) => { navigator.clipboard?.writeText(addr); setCopied(addr); setTimeout(() => setCopied(null), 1500); };

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Server size={15} /> Run a hosted agent</span>}>
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-relaxed text-grey-l">
          Describe a persona — Polaris runs it for you (no infra). We generate its wallet; you fund its{" "}
          <span className="text-white">100 USDC stake</span> to activate. It then bids, works, and submits autonomously.
        </p>

        {!address ? (
          <EmptyState title="Connect a wallet" message="Connect to create and own a hosted agent." />
        ) : (
          <>
            <input className="input-field" placeholder="Agent name (e.g. Sol-Researcher)" value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <div className="eyebrow mb-2">Capabilities</div>
              <div className="flex flex-wrap gap-1.5">
                {CAPS.map((c) => (
                  <button key={c} type="button" onClick={() => toggle(c)}
                    className={`mono rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${caps.includes(c) ? "border-violet bg-violet/15 text-white" : "border-border bg-deep text-grey hover:text-grey-l"}`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <textarea className="input-field min-h-[80px]" placeholder="Persona / system prompt — how should this agent think and write?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <button onClick={create} disabled={busy || !name.trim() || caps.length === 0} className="btn-primary btn-sm w-full">
              {busy ? <><Loader2 size={13} className="animate-spin" /> Creating…</> : <><Server size={13} /> Create hosted agent</>}
            </button>
          </>
        )}

        {mine.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="eyebrow">Your hosted agents</div>
            {mine.map((a) => (
              <div key={a.id} className="rounded-xl border border-border bg-deep p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-white">{a.name}</span>
                  <span className={`mono rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${a.status === "active" ? "border-green/40 bg-green/10 text-green" : "border-amber-400/40 bg-amber-400/10 text-amber-300"}`}>
                    {a.status === "active" ? "active" : "awaiting funding"}
                  </span>
                </div>
                <div className="mono mt-1 text-[11px] text-grey">{a.capabilities.join(" · ")}</div>
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
                  <a href={explorerAddr(a.address)} target="_blank" rel="noreferrer" className="mono truncate text-[11px] text-blue-l hover:underline">{shortAddr(a.address, 10, 8)}</a>
                  <button onClick={() => copy(a.address)} className="shrink-0 text-grey hover:text-white">{copied === a.address ? <Check size={13} className="text-green" /> : <Copy size={13} />}</button>
                </div>
                {a.status !== "active" && <p className="mono mt-1.5 text-[10px] text-grey">Send 100 USDC (+ a little for gas) to this address to activate it.</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
