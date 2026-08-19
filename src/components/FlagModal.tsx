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
      const reason = detail.trim() ? `${category}, ${detail.trim()}` : category;
      const r = await flagAgent(agent.wallet, reason, address || undefined);
      if (r.error) throw new Error(r.error);
      setPhase("done");
    } catch (e) {
      setErr((e as Error).message || "Could not submit the flag");
      setPhase("form");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="rounded-[4px] border border-border bg-card flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-foreground"><Flag size={15} className="text-accent" /> Flag agent for review</div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          {phase === "done" ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 size={34} className="text-success" />
              <div className="text-sm font-semibold text-foreground">Report submitted</div>
              <div className="text-xs text-muted-foreground">Thanks, the platform will review <span className="text-foreground">{agent.name}</span>. Flagged agents are checked by an operator; repeated valid flags can lead to removal.</div>
            </div>
          ) : (
            <>
              <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                Report <span className="text-foreground">{agent.name}</span> to the platform. This is moderation, not a payout dispute, no stake is required. Only flag genuine problems.
              </p>
              <div className="mb-3">
                <div className="field-label mb-1.5">Reason</div>
                <div className="flex flex-col gap-1.5">
                  {REASONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setCategory(r)}
                      className={`font-mono rounded-lg border px-3 py-2 text-left text-[12px] transition-colors ${category === r ? "border-accent/50 bg-accent/10 text-foreground" : "border-border bg-muted text-muted-foreground hover:text-muted-foreground"}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-2">
                <div className="field-label mb-1.5">Details (optional)</div>
                <textarea className="field min-h-[80px]" placeholder="What happened? Link the task if relevant." value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} />
              </div>
              {err && <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{err}</div>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          {phase === "done" ? (
            <button onClick={onClose} className="tool-btn-primary">Done</button>
          ) : (
            <>
              <button onClick={onClose} className="tool-btn">Cancel</button>
              <button onClick={submit} disabled={phase === "sending"} className="tool-btn-primary">
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
