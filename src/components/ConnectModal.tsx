import { useState } from "react";
import { ArrowLeft, Fingerprint, Mail } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "../context/WalletProvider";
import { useNetwork } from "../context/NetworkProvider";
import { humanizeError } from "../lib/errors";
import { PolarisMark } from "./brand/Logo";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Circle wallet connect, for networks whose wallet kind is "circle" (Arc).
 *
 * Two ways in, both Circle's: a device passkey (a smart account, gasless via Circle's
 * paymaster) or an email address with a PIN. BOT Chain never reaches this component,
 * because Circle has no presence there at all and its connect goes straight to the
 * Reown modal from the title bar.
 *
 * Extracted from the old WalletButton so the title bar can own the trigger and stay
 * a single fixed-height row.
 */
export default function ConnectModal({ onClose }: { onClose: () => void }) {
  const { circleEnabled, ucEnabled, lastUsername, lastUcEmail, connect, connectEmailWallet } = useWallet();
  const { network } = useNetwork();
  const [view, setView] = useState<"options" | "passkey" | "email">("options");
  const [mode, setMode] = useState<"register" | "login">(lastUsername ? "login" : "register");
  const [username, setUsername] = useState(lastUsername ?? "");
  const [email, setEmail] = useState(lastUcEmail ?? "");
  const [busy, setBusy] = useState<null | "passkey" | "email">(null);

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

  const headings = {
    options: { title: "Connect to Polaris", sub: `Hire agents and settle onchain on ${network.label}.` },
    passkey: { title: "Passkey wallet", sub: "Choose a username for your device passkey." },
    email: { title: "Continue with email", sub: "A one-time code confirms it is you." },
  }[view];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm p-0 gap-0 bg-card border-border">
        <DialogHeader className="items-center px-6 pt-7 pb-1 space-y-2">
          <PolarisMark size={32} />
          <DialogTitle className="text-base font-semibold tracking-tight">{headings.title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground text-center">{headings.sub}</DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 pt-4">
          {!circleEnabled && !ucEnabled ? (
            <p className="rounded-[4px] border border-accent/30 bg-accent/10 p-3 text-[11px] leading-relaxed text-accent">
              Wallet connection needs Circle credentials. Set{" "}
              <span className="font-mono">VITE_CIRCLE_CLIENT_KEY</span> and{" "}
              <span className="font-mono">VITE_CIRCLE_CLIENT_URL</span> for the passkey wallet, or{" "}
              <span className="font-mono">VITE_CIRCLE_UC_APP_ID</span> for email, then redeploy.
            </p>
          ) : view === "options" ? (
            <div className="flex flex-col gap-2">
              {circleEnabled && (
                <MethodButton
                  icon={<Fingerprint className="h-4 w-4" />}
                  title="Passkey"
                  desc="Face ID or fingerprint on this device. Gasless."
                  disabled={busy !== null}
                  onClick={() => setView("passkey")}
                />
              )}
              {ucEnabled && (
                <MethodButton
                  icon={<Mail className="h-4 w-4" />}
                  title="Email"
                  desc="A one-time code, then a 6-digit PIN."
                  disabled={busy !== null}
                  onClick={() => setView("email")}
                />
              )}
            </div>
          ) : view === "email" ? (
            <div className="flex flex-col gap-3">
              <input
                autoFocus
                type="email"
                inputMode="email"
                autoComplete="email"
                className="field"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goEmail()}
              />
              <button onClick={goEmail} disabled={busy !== null || !email.trim()} className="tool-btn-primary w-full">
                {busy === "email" ? "Check your email…" : "Continue"}
              </button>
              <BackLink onClick={() => setView("options")} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex rounded-[4px] border border-border bg-background p-0.5">
                {(["register", "login"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    data-active={mode === m}
                    className="tool-btn flex-1 data-[active=true]:bg-primary/15 data-[active=true]:text-primary"
                  >
                    {m === "register" ? "Create new" : "Sign in"}
                  </button>
                ))}
              </div>
              <input
                autoFocus
                className="field"
                placeholder="Username, e.g. alice"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goPasskey()}
              />
              <button onClick={goPasskey} disabled={busy !== null || !username.trim()} className="tool-btn-primary w-full">
                {busy === "passkey" ? "Waiting for passkey…" : mode === "register" ? "Create wallet" : "Sign in"}
              </button>
              <BackLink onClick={() => setView("options")} />
            </div>
          )}
        </div>

        <div className="border-t border-border bg-muted px-6 py-2.5 text-center">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Gasless on {network.shortLabel} · secured by Circle
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="tool-btn mx-auto">
      <ArrowLeft className="h-3 w-3" /> All options
    </button>
  );
}

function MethodButton({
  icon,
  title,
  desc,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 rounded-[4px] border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-foreground/[0.03] disabled:opacity-40"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[4px] border border-border bg-muted text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}
