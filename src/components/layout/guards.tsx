import type { ReactNode } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { AlertTriangle, Wallet } from "lucide-react";
import { PolarisMark } from "../brand/Logo";
import { useWallet } from "../../context/WalletProvider";
import { useNetwork } from "../../context/NetworkProvider";
import { EmptyState } from "../ui/primitives";

/**
 * Wrong-network banner, for a wallet connected through wagmi (Reown on BOT Chain, or
 * an injected fallback on Arc). Circle smart accounts are always on Arc, so they never
 * trigger it.
 *
 * The expected chain is the ACTIVE network's, not a hardcoded one: with two networks
 * live, "wrong network" means "not the one you are looking at".
 */
export function NetworkBanner() {
  const chainId = useChainId();
  const { isConnected: walletConnected } = useAccount();
  const { circle } = useWallet();
  const { network } = useNetwork();
  const { switchChain, isPending } = useSwitchChain();

  if (circle || !walletConnected || chainId === network.chainId) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/30 bg-accent/10 px-3 py-1.5">
      <div className="flex items-center gap-2 text-[11px] text-accent">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-mono">
          Your wallet is on chain {chainId}, but you are viewing {network.label} (chain {network.chainId}).
        </span>
      </div>
      <button onClick={() => switchChain({ chainId: network.chainId })} disabled={isPending} className="tool-btn shrink-0">
        {isPending ? "Switching…" : `Switch to ${network.shortLabel}`}
      </button>
    </div>
  );
}

/**
 * Wraps content that needs a connected wallet on the active network.
 *
 * The connect control lives in the title bar, so this states what is needed and points
 * there rather than duplicating a second connect button with its own styling.
 */
export function WalletGate({ children, label }: { children: ReactNode; label?: string }) {
  const { isConnected } = useWallet();
  const { network } = useNetwork();
  if (isConnected) return <>{children}</>;

  const fallback =
    network.wallet.kind === "circle"
      ? `Connect a Circle wallet to continue. Transactions are gasless on ${network.shortLabel}.`
      : `Connect a wallet through Reown to continue on ${network.label}.`;

  return (
    <div className="rounded-[4px] border border-border bg-card">
      <EmptyState
        icon={<PolarisMark size={28} />}
        title="Connect your wallet"
        message={label ?? fallback}
        action={
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Wallet className="h-3.5 w-3.5" /> Use Connect, top right
          </span>
        }
      />
    </div>
  );
}
