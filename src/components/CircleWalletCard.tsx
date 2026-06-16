import { useState } from "react";
import { Fingerprint, ShieldCheck, Copy } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "./ui/primitives";
import { circleEnabled, registerCircleWallet, loginCircleWallet, type CircleSession } from "../lib/circleWallet";
import { shortAddr } from "../lib/utils";

/**
 * Circle Modular Wallet panel — create/log in a passkey-secured smart account on
 * Arc (gasless via Circle Gas Station). Renders only when Circle is configured.
 */
export default function CircleWalletCard() {
  const [username, setUsername] = useState("");
  const [session, setSession] = useState<CircleSession | null>(null);
  const [busy, setBusy] = useState<"register" | "login" | null>(null);

  if (!circleEnabled()) {
    return (
      <Panel title={<span className="inline-flex items-center gap-2"><Fingerprint size={13} /> Circle Wallet</span>}>
        <p className="text-sm leading-relaxed text-grey-l">
          Passkey-secured Circle smart wallets (gasless on Arc via Gas Station) activate once{" "}
          <span className="mono text-grey">VITE_CIRCLE_CLIENT_KEY</span> and{" "}
          <span className="mono text-grey">VITE_CIRCLE_CLIENT_URL</span> are set from the{" "}
          <a href="https://console.circle.com" target="_blank" rel="noreferrer" className="text-blue-l hover:underline">
            Circle console
          </a>
          .
        </p>
      </Panel>
    );
  }

  const run = async (mode: "register" | "login") => {
    if (!username.trim()) return toast.error("Enter a username for the passkey");
    setBusy(mode);
    try {
      const s = mode === "register" ? await registerCircleWallet(username.trim()) : await loginCircleWallet(username.trim());
      setSession(s);
      toast.success(`Circle wallet ${mode === "register" ? "created" : "connected"} · ${shortAddr(s.address)}`);
    } catch (e) {
      toast.error((e as Error).message || "Passkey failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Fingerprint size={13} /> Circle Wallet (passkey)</span>}>
      {session ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-green">
            <ShieldCheck size={16} />
            <span className="mono text-sm">Smart account active</span>
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(session.address);
              toast.success("Address copied");
            }}
            className="mono inline-flex items-center gap-2 rounded-lg border border-border bg-deep px-3 py-2 text-sm text-blue-l"
          >
            {shortAddr(session.address, 10, 8)} <Copy size={12} />
          </button>
          <p className="mono text-[11px] text-grey">Gasless on Arc — fees sponsored by Circle Gas Station.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-grey-l">
            Create or unlock a wallet with a passkey — no seed phrase. Transactions are gasless on Arc.
          </p>
          <input
            className="input-field"
            placeholder="username (e.g. alice@polaris)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <div className="flex gap-2">
            <button onClick={() => run("register")} disabled={!!busy} className="btn-primary flex-1">
              <Fingerprint size={15} /> {busy === "register" ? "Creating…" : "Create"}
            </button>
            <button onClick={() => run("login")} disabled={!!busy} className="btn-ghost flex-1">
              {busy === "login" ? "Connecting…" : "Log in"}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
