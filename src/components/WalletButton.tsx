import { useState } from "react";
import { Fingerprint, LogOut, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "../context/WalletProvider";
import { shortAddr } from "../lib/utils";

/**
 * Primary wallet control (Circle). Replaces the WalletConnect/RainbowKit button.
 * Connects a passkey-secured Circle smart account; gasless on Arc.
 */
export default function WalletButton() {
  const { address, isConnected, circle, circleEnabled, connecting, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");

  if (isConnected && address) {
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="mono inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-white transition-colors hover:border-blue"
        >
          <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-violet text-[9px] text-white">
            {circle ? "C" : "•"}
          </span>
          {shortAddr(address)}
          <ChevronDown size={13} className="text-grey" />
        </button>
        {open && (
          <div className="absolute right-0 z-50 mt-2 w-52 rounded-xl border border-border bg-card p-2 shadow-panel">
            <div className="mono px-2 py-1.5 text-[10px] uppercase tracking-widest text-grey">
              {circle ? "Circle Wallet" : "Injected wallet"}
            </div>
            <div className="mono break-all px-2 pb-2 text-[11px] text-grey-l">{address}</div>
            {circle && (
              <button
                onClick={() => {
                  disconnect();
                  setOpen(false);
                  toast.success("Disconnected");
                }}
                className="mono flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-red hover:bg-deep"
              >
                <LogOut size={13} /> Disconnect
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary !px-4 !py-2 !text-xs">
        <Fingerprint size={14} /> Connect
      </button>
      {open && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            className="panel w-full max-w-sm p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2 text-white">
              <Fingerprint size={18} className="text-blue-l" />
              <h3 className="text-lg font-semibold">Connect Circle Wallet</h3>
            </div>
            <p className="mb-4 text-sm leading-relaxed text-grey-l">
              Passkey-secured smart account on Arc — no seed phrase, gasless transactions.
            </p>

            {!circleEnabled ? (
              <div className="rounded-xl border border-amber/30 bg-amber/5 p-4 text-xs leading-relaxed text-grey-l">
                Circle Modular Wallets need a client key. Add{" "}
                <span className="mono text-grey">VITE_CIRCLE_CLIENT_KEY</span> and{" "}
                <span className="mono text-grey">VITE_CIRCLE_CLIENT_URL</span> from{" "}
                <a href="https://console.circle.com" target="_blank" rel="noreferrer" className="text-blue-l hover:underline">
                  console.circle.com
                </a>{" "}
                to enable, then restart.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <input
                  className="input-field"
                  placeholder="username (e.g. alice)"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    disabled={connecting || !username.trim()}
                    onClick={async () => {
                      try {
                        await connect(username.trim(), "register");
                        setOpen(false);
                        toast.success("Circle wallet created");
                      } catch (e) {
                        toast.error((e as Error).message || "Failed");
                      }
                    }}
                    className="btn-primary flex-1"
                  >
                    {connecting ? "…" : "Create"}
                  </button>
                  <button
                    disabled={connecting || !username.trim()}
                    onClick={async () => {
                      try {
                        await connect(username.trim(), "login");
                        setOpen(false);
                        toast.success("Connected");
                      } catch (e) {
                        toast.error((e as Error).message || "Failed");
                      }
                    }}
                    className="btn-ghost flex-1"
                  >
                    {connecting ? "…" : "Log in"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
