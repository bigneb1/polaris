import { useState } from "react";
import { ShieldCheck, KeyRound } from "lucide-react";
import { Panel } from "./ui/primitives";
import { TIERS, tierLabel } from "./VerifiedBadge";
import { useTx } from "../hooks/useTx";
import { adminSetBadge } from "../lib/api";
import type { Agent } from "../lib/types";

const SECRET_KEY = "polaris_admin_secret";

/**
 * Operator-only verification-tier control. Hidden by default; an operator
 * unlocks it in-app via the "Operator access" prompt below (stored locally
 * after entry — no devtools/localStorage editing required). The grant is
 * executed by the backend, which holds the on-chain AgentBadges admin key and
 * independently re-checks the secret (server/server.js) — so this is a UX
 * convenience, not the real access boundary.
 */
export default function AdminBadgePanel({ agent }: { agent: Agent }) {
  const [secret, setSecret] = useState<string | null>(
    typeof localStorage !== "undefined" ? localStorage.getItem(SECRET_KEY) : null,
  );
  const [unlocking, setUnlocking] = useState(false);
  const [entry, setEntry] = useState("");
  const { run, loading } = useTx();
  const [tier, setTier] = useState<number>(agent.tier ?? 0);
  const [note, setNote] = useState(agent.badgeNote ?? "");

  if (!secret) {
    return (
      <div className="flex justify-end">
        {unlocking ? (
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              className="field !w-56 !py-1.5 text-xs"
              placeholder="Operator secret"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && entry.trim()) {
                  localStorage.setItem(SECRET_KEY, entry.trim());
                  setSecret(entry.trim());
                }
              }}
            />
            <button
              onClick={() => {
                if (!entry.trim()) return;
                localStorage.setItem(SECRET_KEY, entry.trim());
                setSecret(entry.trim());
              }}
              className="tool-btn"
            >
              Unlock
            </button>
          </div>
        ) : (
          <button onClick={() => setUnlocking(true)} className="font-mono inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-muted-foreground">
            <KeyRound size={11} /> Operator access
          </button>
        )}
      </div>
    );
  }

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><ShieldCheck size={14} /> Verification (admin)</span>}>
      <div className="flex flex-col gap-3">
        <div className="font-mono text-[11px] text-muted-foreground">Current: {tierLabel(agent.tier)}</div>
        <label className="block">
          <div className="field-label mb-1.5">Tier</div>
          <select className="field" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            <option value={0}>0, Unverified</option>
            {TIERS.map((t, i) => (i === 0 ? null : <option key={i} value={i}>{i}, {t!.label}</option>))}
          </select>
        </label>
        <label className="block">
          <div className="field-label mb-1.5">Note (optional)</div>
          <input className="field" placeholder="e.g. KYC verified by Circle" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button
          onClick={() =>
            run(async () => {
              const r = await adminSetBadge(secret, agent.wallet, tier, note);
              if (r.error) throw new Error(r.error);
              return (r.txHash ?? "0x") as `0x${string}`;
            }, { pending: "Granting tier on-chain…", success: "Verification tier updated" })
          }
          disabled={loading}
          className="tool-btn-primary w-full"
        >
          Grant tier
        </button>
      </div>
    </Panel>
  );
}
