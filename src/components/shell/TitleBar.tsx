import { Link } from "react-router-dom";
import { Check, ChevronDown, Fingerprint, Lock, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "../../context/WalletProvider";
import { useNetwork } from "../../context/NetworkProvider";
import { shortAddr, fmtUSDC, cn } from "../../lib/utils";
import { humanizeError } from "../../lib/errors";
import { PolarisMark } from "../brand/Logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ConnectModal from "../ConnectModal";
import WalletAccountPanel from "../WalletAccountPanel";
import { openReownAccount, openReownNetworks } from "../../lib/wallets/reown";
import { useState } from "react";

/**
 * The top bar: identity on the left, network and wallet on the right.
 *
 * Everything here is h-7 and 11px, matching the rest of the chrome. The connect
 * control is deliberately the same size as the connected wallet pill, so the bar
 * never reflows when a wallet connects, and never changes size between a Circle
 * network and a Reown one.
 */
/**
 * What the connected pill shows. Hoisted rather than nested: a component declared inside
 * another is a new type on every render, which remounts it and loses any state it holds.
 */
function WalletPillContents({
  providerName,
  balance,
  balanceSymbol,
  address,
  wrongNetwork,
  networkLabel,
}: {
  providerName: string | null;
  balance: number | null;
  balanceSymbol: string;
  address: string;
  wrongNetwork: boolean;
  networkLabel: string;
}) {
  // A wallet sitting on another chain is not a healthy connection, and the dot is
  // the only thing on screen that claims it is. Say which chain the app wants
  // instead of showing a balance read from a chain the wallet isn't on.
  if (wrongNetwork) {
    return (
      <>
        <span className="status-dot bg-destructive shrink-0" />
        <span className="hidden sm:inline text-[11px] text-destructive whitespace-nowrap">
          Switch to {networkLabel}
        </span>
        <span className="text-[11px] font-mono text-foreground whitespace-nowrap">{shortAddr(address)}</span>
      </>
    );
  }
  return (
    <>
      <span className="status-dot bg-success shrink-0" />
      {providerName && (
        <span className="hidden md:inline text-[11px] text-muted-foreground whitespace-nowrap">
          {providerName}
        </span>
      )}
      {balance != null && (
        <span className="hidden sm:inline text-[11px] text-muted-foreground whitespace-nowrap">
          {fmtUSDC(balance)} {balanceSymbol}
        </span>
      )}
      <span className="text-[11px] font-mono text-foreground whitespace-nowrap">{shortAddr(address)}</span>
    </>
  );
}

export function TitleBar() {
  const { network, all, setNetwork, multiNetwork } = useNetwork();
  const {
    isConnected,
    address,
    balance,
    balanceSymbol,
    circle,
    uc,
    walletKind,
    connectReown,
    reownEnabled,
    connecting,
    connectorName,
    wrongNetwork,
    disconnect,
  } = useWallet();
  const [modalOpen, setModalOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // The wallet as it names itself. "Reown" used to be printed here, which is the connection
  // library, not anyone's wallet: a brand the user never chose and cannot act on.
  const providerName = connectorName;
  // An external wallet has AppKit's own account screen; ours do not, so they get an
  // equivalent panel rather than a button that does nothing.
  const usesReownAccount = walletKind === "reown" && !circle && !uc;

  return (
    <header className="h-11 shrink-0 flex items-center justify-between gap-2 px-2 sm:px-3 border-b border-border bg-muted select-none">
      <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity min-w-0 shrink-0">
        <PolarisMark size={18} />
        <span className="text-[13px] font-semibold tracking-tight text-foreground whitespace-nowrap">Polaris</span>
      </Link>

      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
        {/* Network chip. Switching here changes the data source and the transaction
            target, not just a label, so it sits beside the wallet rather than being
            buried in a menu. */}
        {multiNetwork ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 h-7 px-2 sm:px-2.5 rounded-[4px] bg-background border border-border text-[11px] text-muted-foreground hover:text-foreground transition-colors shrink-0">
              <img src={network.logo} alt="" className="h-3.5 w-3.5 rounded-full shrink-0" />
              <span className="hidden xs:inline whitespace-nowrap">{network.shortLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {all.map((net) => {
                const asset = net.assets.find((a) => a.isEscrowAsset);
                return (
                  <DropdownMenuItem
                    key={net.id}
                    disabled={!net.deployed}
                    onClick={() => setNetwork(net.id)}
                    className="gap-2"
                  >
                    <img
                      src={net.logo}
                      alt=""
                      className={cn("h-4 w-4 rounded-full shrink-0", !net.deployed && "opacity-40")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{net.label}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        chain {net.chainId} · {asset?.symbol}
                        {net.deployed ? "" : " · not deployed yet"}
                      </span>
                    </span>
                    {net.id === network.id ? (
                      <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                    ) : !net.deployed ? (
                      <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="hidden sm:inline text-[10px] text-muted-foreground border border-border rounded-[3px] px-1.5 py-0.5 whitespace-nowrap">
            {network.label}
          </span>
        )}

        {isConnected && address ? (
          <>
            {/*
              A button, not a div. Clicking a connected address is how every wallet works, and
              this one used to be inert: no copy, no explorer link, no way to read the address
              in full. External wallets open AppKit's own account view; ours open the
              equivalent panel.
            */}
            {usesReownAccount ? (
              <button
                onClick={() => (wrongNetwork ? openReownNetworks() : openReownAccount())}
                title={wrongNetwork ? `Switch your wallet to ${network.label}` : "Wallet details"}
                className="flex items-center gap-1.5 h-7 px-2 sm:px-2.5 rounded-[4px] bg-background border border-border min-w-0 hover:bg-foreground/[0.06] transition-colors"
              >
                <WalletPillContents
                  providerName={providerName}
                  balance={balance}
                  balanceSymbol={balanceSymbol}
                  address={address}
                  wrongNetwork={wrongNetwork}
                  networkLabel={network.shortLabel}
                />
              </button>
            ) : (
              <DropdownMenu open={accountOpen} onOpenChange={setAccountOpen}>
                <DropdownMenuTrigger
                  title="Wallet details"
                  className="flex items-center gap-1.5 h-7 px-2 sm:px-2.5 rounded-[4px] bg-background border border-border min-w-0 hover:bg-foreground/[0.06] transition-colors"
                >
                  <WalletPillContents
                  providerName={providerName}
                  balance={balance}
                  balanceSymbol={balanceSymbol}
                  address={address}
                  wrongNetwork={wrongNetwork}
                  networkLabel={network.shortLabel}
                />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="p-0">
                  <WalletAccountPanel onClose={() => setAccountOpen(false)} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              onClick={() => {
                disconnect();
                toast.success("Disconnected");
              }}
              title="Disconnect wallet"
              className="tool-btn h-7 w-7 px-0 shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : walletKind === "reown" ? (
          <button
            onClick={() =>
              connectReown().catch((e) =>
                toast.error(
                  humanizeError(
                    e,
                    reownEnabled
                      ? "Could not open the wallet modal. Please try again."
                      : `Reown isn't configured. Set VITE_REOWN_PROJECT_ID to connect on ${network.label}.`,
                  ),
                ),
              )
            }
            disabled={connecting}
            className="tool-btn-primary shrink-0"
          >
            <Wallet className="h-3.5 w-3.5" />
            <span className="hidden xs:inline">{connecting ? "Connecting…" : "Connect"}</span>
          </button>
        ) : (
          <>
            <button onClick={() => setModalOpen(true)} className="tool-btn-primary shrink-0">
              <Fingerprint className="h-3.5 w-3.5" />
              <span className="hidden xs:inline">Connect</span>
            </button>
            {modalOpen && <ConnectModal onClose={() => setModalOpen(false)} />}
          </>
        )}
      </div>
    </header>
  );
}
