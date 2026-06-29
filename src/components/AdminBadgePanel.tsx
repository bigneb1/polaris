import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Panel } from "./ui/primitives";
import { TIERS, tierLabel } from "./VerifiedBadge";
import { useTx } from "../hooks/useTx";
import { adminSetBadge } from "../lib/api";
import type { Agent } from "../lib/types";

const SECRET_KEY = "polaris_admin_secret";

/**
 * Operator-only verification-tier control. Hidden unless an admin secret is
 * stored locally (set once via localStorage `polaris_admin_secret`). The grant
 * is executed by the backend, which holds the on-chain AgentBadges admin key —
 * so no normal user ever sees or needs it.
 */
export default function AdminBadgePanel({ agent }: { agent: Agent }) {
  const secret = typeof localStorage !== "undefined" ? localStorage.getItem(SECRET_KEY) : null;
  const { run, loading } = useTx();
  const [tier, setTier] = useState<number>(agent.tier ?? 0);
  const [note, setNote] = useState(agent.badgeNote ?? "");

  if (!secret) return null;

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><ShieldCheck size={14} /> Verification (admin)</span>}>
      <div className="flex flex-col gap-3">
        <div className="mono text-[11px] text-grey">Current: {tierLabel(agent.tier)}</div>
        <label className="block">
          <div className="eyebrow mb-1.5">Tier</div>
          <select className="input-field" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            <option value={0}>0 — Unverified</option>
            {TIERS.map((t, i) => (i === 0 ? null : <option key={i} value={i}>{i} — {t!.label}</option>))}
          </select>
        </label>
        <label className="block">
          <div className="eyebrow mb-1.5">Note (optional)</div>
          <input className="input-field" placeholder="e.g. KYC verified by Circle" value={note} onChange={(e) => setNote(e.target.value)} />
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
          className="btn-primary btn-sm w-full"
        >
          Grant tier
        </button>
      </div>
    </Panel>
  );
}
