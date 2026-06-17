import { useState, useEffect } from "react";
import { Fingerprint, LogOut, ChevronDown, Copy, Check, KeyRound, X } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "../context/WalletProvider";
import { shortAddr, fmtUSDC } from "../lib/utils";
import { USDCAmount } from "./ui/primitives";

/**
 * Primary wallet control. Connected: shows USDC balance, address + copy, and
 * disconnect. Disconnected: opens a centered modal of connect options (passkey
 * smart wallet, returning passkey login). Options are described by capability,
 * not brand name.
 */
export default function WalletButton() {
  const { address, isConnected, circle, balance, lastUsername, disconnect } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    toast.success("Address copied");
    setTimeout(() => setCopied(false), 1500);
  };

  if (isConnected && address) {
    return (
      <div className="relative">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="mono inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-white transition-colors hover:border-blue"
        >
          {balance != null && <span className="hidden text-grey-l sm:inline">{fmtUSDC(balance)} USDC</span>}
          <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-violet text-[9px] text-white">
            {circle ? (circle.username[0] || "C").toUpperCase() : "•"}
          </span>
          <span>{shortAddr(address)}</span>
          <ChevronDown size={13} className="text-grey" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-panel">
              <div className="eyebrow mb-1 !text-[9px]">{circle ? `Passkey wallet · ${circle.username}` : "Injected wallet"}</div>
              <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-deep px-3 py-2">
                <span className="mono text-xs text-grey-l">{shortAddr(address, 8, 6)}</span>
                <button onClick={copy} className="text-grey hover:text-blue-l" title="Copy address">
                  {copied ? <Check size={13} className="text-green" /> : <Copy size={13} />}
                </button>
              </div>
              <div className="mb-3 rounded-lg border border-border bg-deep px-3 py-2.5">
                <div className="eyebrow mb-1 !text-[9px]">USDC Balance</div>
                <USDCAmount amount={balance ?? 0} size="md" className="text-white" />
              </div>
              {circle && (
                <button
                  onClick={() => {
                    disconnect();
                    setMenuOpen(false);
                    toast.success("Disconnected");
                  }}
                  className="mono flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-red hover:bg-deep"
                >
                  <LogOut size={13} /> Disconnect
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setModalOpen(true)} className="btn-primary !px-4 !py-2 !text-xs">
        <Fingerprint size={14} /> Connect
      </button>
      {modalOpen && <ConnectModal onClose={() => setModalOpen(false)} lastUsername={lastUsername} />}
    </>
  );
}

/* ── Centered connect modal ─────────────────────────────────────────────────*/
function ConnectModal({ onClose, lastUsername }: { onClose: () => void; lastUsername: string | null }) {
  const { circleEnabled, connecting, connect } = useWallet();
  const [view, setView] = useState<"options" | "create" | "login">(lastUsername ? "login" : "options");
  const [username, setUsername] = useState(lastUsername ?? "");

  // close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = async (mode: "register" | "login") => {
    if (!username.trim()) return toast.error("Enter a username");
    try {
      await connect(username.trim(), mode);
      onClose();
      toast.success(mode === "register" ? "Wallet created" : "Welcome back");
    } catch (e) {
      toast.error((e as Error).message || "Passkey failed");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="panel w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Connect a wallet</h3>
            <p className="mt-1 text-sm text-grey-l">Choose how you want to sign in. Gasless on Arc Testnet.</p>
          </div>
          <button onClick={onClose} className="text-grey hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {!circleEnabled ? (
          <div className="rounded-xl border border-amber/30 bg-amber/5 p-4 text-xs leading-relaxed text-grey-l">
            Wallet connection needs a Circle client key. Add{" "}
            <span className="mono text-grey">VITE_CIRCLE_CLIENT_KEY</span> and{" "}
            <span className="mono text-grey">VITE_CIRCLE_CLIENT_URL</span> from the Circle console, then redeploy.
          </div>
        ) : view === "options" ? (
          <div className="flex flex-col gap-3">
            <OptionRow
              icon={<Fingerprint size={18} />}
              title="Create a smart wallet"
              desc="Secured by a passkey on this device. No seed phrase, gasless transactions."
              onClick={() => setView("create")}
            />
            <OptionRow
              icon={<KeyRound size={18} />}
              title="Sign in with a passkey"
              desc="Return to a wallet you already created with your passkey."
              onClick={() => setView("login")}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <button onClick={() => setView("options")} className="mono self-start text-xs text-grey hover:text-grey-l">
              ← Back
            </button>
            <label className="block">
              <div className="eyebrow mb-2">Username</div>
              <input
                autoFocus
                className="input-field"
                placeholder="e.g. alice"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && go(view === "create" ? "register" : "login")}
              />
            </label>
            <button
              onClick={() => go(view === "create" ? "register" : "login")}
              disabled={connecting || !username.trim()}
              className="btn-primary w-full"
            >
              {connecting ? "Waiting for passkey…" : view === "create" ? "Create wallet" : "Sign in"}
            </button>
            <p className="mono text-center text-[11px] text-grey">
              {view === "create"
                ? "Your passkey is saved by your device, tied to this username."
                : "Use the passkey you created with this username."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function OptionRow({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 rounded-xl border border-border bg-deep p-4 text-left transition-colors hover:border-blue"
    >
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border2 bg-card text-blue-l">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-grey-l">{desc}</span>
      </span>
    </button>
  );
}
