import type { ReactNode } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { AlertTriangle } from "lucide-react";
import { arcTestnet, ARC_CHAIN_ID } from "../../lib/chain";
import { PolarisMark } from "../brand/Logo";
import { useWallet } from "../../context/WalletProvider";
import WalletButton from "../WalletButton";

/**
 * Wrong-network banner — only relevant for an injected fallback wallet. Circle
 * smart accounts are always on Arc, so they never trigger it.
 */
export function NetworkBanner() {
  const chainId = useChainId();
  const { isConnected: injectedConnected } = useAccount();
  const { circle } = useWallet();
  const { switchChain, isPending } = useSwitchChain();

  if (circle || !injectedConnected || chainId === ARC_CHAIN_ID) return null;

  return (
    <div className="flex items-center justify-between gap-4 border-b border-amber/30 bg-amber/10 px-6 py-2.5">
      <div className="flex items-center gap-2 text-sm text-amber">
        <AlertTriangle size={16} />
        <span className="mono">Wrong network. Polaris runs on Arc Testnet (chain {ARC_CHAIN_ID}).</span>
      </div>
      <button onClick={() => switchChain({ chainId: arcTestnet.id })} disabled={isPending} className="btn-ghost !border-amber/50 !py-2 !text-amber">
        {isPending ? "Switching…" : "Switch to Arc"}
      </button>
    </div>
  );
}

/** Wraps content that requires a connected wallet (Circle-primary). */
export function WalletGate({ children, label }: { children: ReactNode; label?: string }) {
  const { isConnected } = useWallet();
  if (isConnected) return <>{children}</>;
  return (
    <div className="flex flex-col items-center justify-center gap-5 px-6 py-24 text-center">
      <PolarisMark size={48} glow />
      <div>
        <div className="text-xl font-semibold text-white">Connect your wallet</div>
        <p className="mx-auto mt-1 max-w-sm text-sm text-grey-l">
          {label ?? "Connect a Circle passkey wallet to continue — gasless on Arc."}
        </p>
      </div>
      <WalletButton />
    </div>
  );
}
