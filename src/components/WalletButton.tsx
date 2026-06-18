import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Fingerprint, LogOut, ChevronDown, ChevronRight, Copy, Check, X, Mail, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "../context/WalletProvider";
import { shortAddr, fmtUSDC, cn } from "../lib/utils";
import { humanizeError } from "../lib/errors";
import { PolarisMark } from "./brand/Logo";
import { USDCAmount } from "./ui/primitives";

/**
 * Primary wallet control. Connected: shows USDC balance, address + copy, and
 * disconnect. Disconnected: opens a centered modal of connect options (passkey
 * smart wallet, returning passkey login). Options are described by capability,
 * not brand name.
 */
export default function WalletButton() {
  const { address, isConnected, circle, uc, balance, lastUsername, disconnect } = useWallet();
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
            {circle ? (circle.username[0] || "C").toUpperCase() : uc ? "P" : "•"}
          </span>
          <span>{shortAddr(address)}</span>
          <ChevronDown size={13} className="text-grey" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-panel">
              <div className="eyebrow mb-1 !text-[9px]">
                {circle ? `Passkey wallet · ${circle.username}` : uc ? "PIN wallet · Circle" : "Injected wallet"}
              </div>
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
              {(circle || uc) && (
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

/* ── Centered connect modal (Privy-style, portaled to body) ─────────────────*/
function ConnectModal({ onClose, lastUsername }: { onClose: () => void; lastUsername: string | null }) {
  const { circleEnabled, ucEnabled, lastUcEmail, connect, connectEmailWallet } = useWallet();
  const [view, setView] = useState<"options" | "passkey" | "email">("options");
  const [mode, setMode] = useState<"register" | "login">(lastUsername ? "login" : "register");
  const [username, setUsername] = useState(lastUsername ?? "");
  const [email, setEmail] = useState(lastUcEmail ?? "");
  const [busy, setBusy] = useState<null | "passkey" | "email">(null);
  const [mounted, setMounted] = useState(false);

  // entrance animation + close on Escape
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const goPasskey = async () => {
    if (!username.trim()) return toast.error("Enter a username");
    setBusy("passkey");
    try {
      await connect(username.trim(), mode);
      onClose();
      toast.success(mode === "register" ? "Wallet created" : "Welcome back");
    } catch (e) {
      toast.error(humanizeError(e, "Could not connect your passkey wallet. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const goEmail = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return toast.error("Enter a valid email");
    setBusy("email");
    try {
      await connectEmailWallet(email.trim());
      onClose();
      toast.success("Wallet connected");
    } catch (e) {
      toast.error(humanizeError(e, "Could not sign in with email. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const headings: Record<typeof view, { title: string; sub: string }> = {
    options: { title: "Log in to Polaris", sub: "Connect a wallet to hire agents and settle in USDC." },
    passkey: { title: "Passkey wallet", sub: "Choose a username for your device passkey." },
    email: { title: "Continue with email", sub: "We'll send a one-time code to verify it's you." },
  };

  const modal = (
    <div
      className={cn(
        "fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md transition-opacity duration-200",
        mounted ? "opacity-100" : "opacity-0",
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={cn(
          "relative w-full max-w-[400px] overflow-hidden rounded-2xl border border-border bg-card shadow-panel transition-all duration-200",
          mounted ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg text-grey transition-colors hover:bg-deep hover:text-white"
          aria-label="Close"
        >
          <X size={17} />
        </button>

        {/* Brand header */}
        <div className="flex flex-col items-center px-7 pb-2 pt-9 text-center">
          <PolarisMark size={40} />
          <h3 className="mt-4 text-xl font-semibold tracking-tight text-white">{headings[view].title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-grey-l">{headings[view].sub}</p>
        </div>

        <div className="px-7 pb-7 pt-5">
          {!circleEnabled && !ucEnabled ? (
            <div className="rounded-xl border border-amber/30 bg-amber/5 p-4 text-xs leading-relaxed text-grey-l">
              Wallet connection needs Circle credentials. Add{" "}
              <span className="mono text-grey">VITE_CIRCLE_CLIENT_KEY</span> /{" "}
              <span className="mono text-grey">VITE_CIRCLE_CLIENT_URL</span> (passkey) or{" "}
              <span className="mono text-grey">VITE_CIRCLE_UC_APP_ID</span> (email), then redeploy.
            </div>
          ) : view === "options" ? (
            <div className="flex flex-col gap-2.5">
              {ucEnabled && (
                <MethodButton
                  icon={<Mail size={18} />}
                  title="Email"
                  desc="One-time code to your inbox. Gasless, no seed phrase."
                  disabled={busy !== null}
                  onClick={() => setView("email")}
                />
              )}
              {circleEnabled && (
                <MethodButton
                  icon={<Fingerprint size={18} />}
                  title="Passkey"
                  desc="Face ID or fingerprint on this device. Gasless."
                  disabled={busy !== null}
                  onClick={() => setView("passkey")}
                />
              )}
            </div>
          ) : view === "email" ? (
            <div className="flex flex-col gap-4">
              <input
                autoFocus
                type="email"
                inputMode="email"
                autoComplete="email"
                className="input-field"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goEmail()}
              />
              <button onClick={goEmail} disabled={busy !== null || !email.trim()} className="btn-primary w-full">
                {busy === "email" ? "Check your email & follow the steps…" : "Continue"}
              </button>
              <button
                onClick={() => setView("options")}
                className="mono inline-flex items-center justify-center gap-1.5 text-xs text-grey hover:text-grey-l"
              >
                <ArrowLeft size={13} /> All options
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* segmented create / sign-in toggle */}
              <div className="flex rounded-xl border border-border bg-deep p-1">
                {(["register", "login"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors",
                      mode === m ? "bg-card text-white shadow-soft" : "text-grey hover:text-grey-l",
                    )}
                  >
                    {m === "register" ? "Create new" : "Sign in"}
                  </button>
                ))}
              </div>
              <input
                autoFocus
                className="input-field"
                placeholder="Username, e.g. alice"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goPasskey()}
              />
              <button onClick={goPasskey} disabled={busy !== null || !username.trim()} className="btn-primary w-full">
                {busy === "passkey"
                  ? "Waiting for passkey…"
                  : mode === "register"
                    ? "Create wallet"
                    : "Sign in"}
              </button>
              <button
                onClick={() => setView("options")}
                className="mono inline-flex items-center justify-center gap-1.5 text-xs text-grey hover:text-grey-l"
              >
                <ArrowLeft size={13} /> All options
              </button>
            </div>
          )}
        </div>

        {/* Footer trust line */}
        <div className="border-t border-border bg-deep/60 px-7 py-3.5 text-center">
          <span className="mono text-[10px] uppercase tracking-widest text-grey">
            Gasless on Arc · secured by Circle
          </span>
        </div>
      </div>
    </div>
  );

  // Portal to <body> so the modal centers on the viewport, not inside the
  // backdrop-blurred header (a backdrop-filter ancestor would otherwise become
  // the containing block for position:fixed and pin the modal to the header).
  return createPortal(modal, document.body);
}

function MethodButton({
  icon,
  title,
  desc,
  onClick,
  loading,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex items-center gap-3 rounded-xl border border-border bg-deep p-3.5 text-left transition-all hover:border-blue hover:bg-card disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border2 bg-card text-blue-l">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block truncate text-xs text-grey-l">{desc}</span>
      </span>
      {loading ? (
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border2 border-t-blue-l" />
      ) : (
        <ChevronRight size={17} className="shrink-0 text-grey transition-transform group-hover:translate-x-0.5 group-hover:text-grey-l" />
      )}
    </button>
  );
}
