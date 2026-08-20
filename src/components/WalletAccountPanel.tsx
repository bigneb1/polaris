import { useState } from "react";
import { Check, Copy, ExternalLink, LogOut } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "../context/WalletProvider";
import { useNetwork } from "../context/NetworkProvider";
import { explorerAddr } from "../lib/chain";
import { fmtUSDC } from "../lib/utils";

/**
 * The account view for Polaris's own wallet modes.
 *
 * An external wallet connected through AppKit has its own account screen, and clicking the
 * address opens it. The Passkey and PIN wallets have no such screen, so a click there would
 * do nothing at all: worse than the inert address it replaced. This is the equivalent, built
 * from what the wallet context already knows.
 *
 * Deliberately the same four things every wallet offers: see the full address, copy it, open
 * it in the explorer, and disconnect. A connected user should never have to read their
 * address off a truncated pill.
 */
export default function WalletAccountPanel({ onClose }: { onClose: () => void }) {
  const { address, balance, balanceSymbol, connectorName, disconnect } = useWallet();
  const { network } = useNetwork();
  const [copied, setCopied] = useState(false);

  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the full address is on screen to copy by hand.
      toast.error("Could not copy. The full address is shown above.");
    }
  };

  return (
    <div className="w-[280px] p-3">
      <div className="field-label mb-1">{connectorName ?? "Wallet"} · {network.label}</div>

      {/* The whole address, not a truncation: this is the one place it must be readable. */}
      <div className="break-all rounded-[4px] border border-border bg-muted px-2.5 py-2 font-mono text-[11px] text-foreground">
        {address}
      </div>

      {balance != null && (
        <div className="mt-2 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Balance</span>
          <span className="font-mono text-foreground">
            {fmtUSDC(balance)} {balanceSymbol}
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-1.5">
        <button onClick={copy} className="tool-btn w-full justify-start">
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy address"}
        </button>
        <a
          href={explorerAddr(address)}
          target="_blank"
          rel="noreferrer"
          className="tool-btn w-full justify-start"
        >
          <ExternalLink className="h-3.5 w-3.5" /> View on {network.explorerName}
        </a>
        <button
          onClick={() => {
            disconnect();
            onClose();
            toast.success("Disconnected");
          }}
          className="tool-btn-danger w-full justify-start"
        >
          <LogOut className="h-3.5 w-3.5" /> Disconnect
        </button>
      </div>
    </div>
  );
}
