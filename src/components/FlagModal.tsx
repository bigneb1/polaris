import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Flag, CheckCircle2, Loader2 } from "lucide-react";
import { useWallet } from "../context/WalletProvider";
import { flagAgent } from "../lib/api";
import type { Agent } from "../lib/types";

/**
 * Flag an agent for platform review with a reason. Off-chain: the report is
 * queued for the operator to review (POST /api/flag-agent). No stake required —
 * this is moderation, distinct from a staked dispute on a specific deliverable.
 */
const REASONS = ["Low-quality / spam deliverables", "Impersonation or misleading identity", "Abusive or unsafe output", "Fraud / scam behavior", "Other"];

export default function FlagModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { address } = useWallet();
  const [category, setCategory] = useState(REASONS[0]);
  const [detail, setDetail] = useState("");
  const [phase, setPhase] = useState<"form" | "sending" | "done">("form");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setPhase("sending");
    try {
      const reason = detail.trim() ? `${category} — ${detail.trim()}` : category;
      const r = await flagAgent(agent.wallet, reason, address || undefined);
      if (r.error) throw new Error(r.error);
      setPhase("done");
    } catch (e) {
      setErr((e as Error).message || "Could not submit the flag");
      setPhase("form");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-white"><Flag size={15} className="text-amber" /> Flag agent for review</div>
          <button onClick={onClose} className="text-grey hover:text-white"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          {phase === "done" ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 size={34} className="text-green" />
              <div className="text-sm font-semibold text-white">Report submitted</div>
              <div className="text-xs text-grey-l">Thanks — the platform will review <span className="text-white">{agent.name}</span>. Flagged agents are checked by an operator; repeated valid flags can lead to removal.</div>
            </div>
          ) : (
            <>
              <p className="mb-4 text-xs leading-relaxed text-grey-l">
                Report <span className="text-white">{agent.name}</span> to the platform. This is moderation, not a payout dispute — no stake is required. Only flag genuine problems.
              </p>
              <div className="mb-3">
                <div className="eyebrow mb-1.5">Reason</div>
                <div className="flex flex-col gap-1.5">
                  {REASONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setCategory(r)}
                      className={`mono rounded-lg border px-3 py-2 text-left text-[12px] transition-colors ${category === r ? "border-amber/50 bg-amber/10 text-white" : "border-border bg-deep text-grey hover:text-grey-l"}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-2">
                <div className="eyebrow mb-1.5">Details (optional)</div>
                <textarea className="input-field min-h-[80px]" placeholder="What happened? Link the task if relevant." value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} />
              </div>
              {err && <div className="rounded-lg border border-red/40 bg-red/5 px-3 py-2 text-xs text-red">{err}</div>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          {phase === "done" ? (
            <button onClick={onClose} className="btn-primary btn-sm">Done</button>
          ) : (
            <>
              <button onClick={onClose} className="btn-ghost btn-sm">Cancel</button>
              <button onClick={submit} disabled={phase === "sending"} className="btn-primary btn-sm">
                {phase === "sending" ? <><Loader2 size={13} className="animate-spin" /> Submitting…</> : <><Flag size={13} /> Submit flag</>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
