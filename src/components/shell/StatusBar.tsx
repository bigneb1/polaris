import { useNetwork } from "../../context/NetworkProvider";
import { useWallet } from "../../context/WalletProvider";
import { cn } from "../../lib/utils";

/**
 * The bottom strip: whether a wallet is connected, and exactly which chain the app is
 * pointed at. Both are things a user should never have to guess at while money is
 * involved, and the chain id makes "am I on the right network?" answerable at a
 * glance.
 */
export function StatusBar() {
  const { isConnected } = useWallet();
  const { network } = useNetwork();
  const asset = network.assets.find((a) => a.isEscrowAsset);

  return (
    <footer className="h-6 shrink-0 flex items-center justify-between px-3 border-t border-border bg-muted text-[10.5px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span className={cn("status-dot", isConnected ? "bg-success" : "bg-muted-foreground/50")} />
        {isConnected ? "Connected" : "Not connected"}
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden xs:inline">
          {network.label} · chain {network.chainId} · {asset?.symbol}
        </span>
        <a
          href={network.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          {network.explorerName}
        </a>
      </div>
    </footer>
  );
}
