import { useChainId } from "wagmi";
import { useWallet } from "../context/WalletProvider";
import { Check, X, ExternalLink, Copy } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "../components/ui/cards";
import { Panel, StatusBadge } from "../components/ui/primitives";
import { ARC_CHAIN_ID, ARC_RPC_URL, ARC_EXPLORER } from "../lib/chain";
import { CONTRACTS, isDeployed } from "../lib/contracts";
import { shortAddr } from "../lib/utils";
import CircleWalletCard from "../components/CircleWalletCard";

const CONTRACT_ROWS: { key: keyof typeof CONTRACTS; label: string }[] = [
  { key: "usdc", label: "USDC (native)" },
  { key: "usdcEscrow", label: "USDCEscrow" },
  { key: "agentRegistry", label: "AgentRegistry" },
  { key: "bidEngine", label: "BidEngine" },
  { key: "taskRegistry", label: "TaskRegistry" },
  { key: "verifierBridge", label: "VerifierBridge" },
  { key: "revenueRouter", label: "RevenueRouter" },
];

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success("Copied");
}

export default function SettingsPage() {
  const { address, isConnected } = useWallet();
  const chainId = useChainId();
  const onArc = chainId === ARC_CHAIN_ID;

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Network & contracts" sub="The live Arc configuration this build is wired to." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Network">
          <dl className="flex flex-col gap-3">
            <KV k="Network" v="Arc Testnet" />
            <KV k="Chain ID" v={String(ARC_CHAIN_ID)} />
            <KV k="RPC URL" v={ARC_RPC_URL} copy />
            <KV k="Explorer" v={ARC_EXPLORER} link={ARC_EXPLORER} />
            <KV k="Gas token" v="USDC (6-dec ERC20 iface)" />
            <KV k="Wallet" v={isConnected ? shortAddr(address) : "not connected"} />
            <div className="flex items-center justify-between">
              <span className="mono text-xs text-grey">Connection</span>
              <StatusBadge status={onArc ? "ONLINE" : isConnected ? "OFFLINE" : "PENDING"} />
            </div>
          </dl>
        </Panel>

        <Panel title="Contract Addresses">
          <div className="flex flex-col gap-2.5">
            {CONTRACT_ROWS.map(({ key, label }) => {
              const live = isDeployed(key);
              return (
                <div key={key} className="flex items-center justify-between rounded-lg border border-border bg-deep px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {live ? <Check size={14} className="text-green" /> : <X size={14} className="text-grey" />}
                    <span className="mono text-xs text-grey-l">{label}</span>
                  </div>
                  <button
                    onClick={() => live && copy(CONTRACTS[key])}
                    className="mono inline-flex items-center gap-1.5 text-xs text-blue-l disabled:text-grey"
                    disabled={!live}
                  >
                    {live ? shortAddr(CONTRACTS[key]) : "not deployed"}
                    {live && <Copy size={11} />}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="mono mt-4 text-[11px] leading-relaxed text-grey">
            Addresses come from <span className="text-grey-l">VITE_CONTRACT_*</span> env vars, set after
            running the Hardhat deploy script to Arc Testnet.
          </p>
        </Panel>

        <CircleWalletCard />
      </div>

      <div className="panel mt-6 flex items-start gap-3 p-5">
        <ExternalLink size={16} className="mt-0.5 shrink-0 text-blue-l" />
        <p className="text-xs leading-relaxed text-grey-l">
          Need testnet USDC? Use the Circle faucet for Arc Testnet, then add the network to your wallet
          (chain {ARC_CHAIN_ID}, RPC {ARC_RPC_URL}). USDC is the native gas token, so you need a small
          balance to transact.
        </p>
      </div>
    </div>
  );
}

function KV({ k, v, copy: canCopy, link }: { k: string; v: string; copy?: boolean; link?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="mono text-xs text-grey">{k}</span>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1.5 truncate text-xs text-blue-l hover:underline">
          {v} <ExternalLink size={11} />
        </a>
      ) : canCopy ? (
        <button onClick={() => copy(v)} className="mono inline-flex items-center gap-1.5 truncate text-xs text-grey-l">
          {v} <Copy size={11} />
        </button>
      ) : (
        <span className="mono truncate text-xs text-grey-l">{v}</span>
      )}
    </div>
  );
}
