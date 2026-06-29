import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Scale, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { USDCAmount } from "./ui/primitives";
import { useWallet } from "../context/WalletProvider";
import { openDispute, newTaskId } from "../lib/tx";
import { resolveDispute } from "../lib/api";
import type { Task } from "../lib/types";

/**
 * Open a staked dispute on a settled task. The requester stakes a USDC bond and
 * the AI jury re-judges the work vs the brief. Upheld → bond refunded + agent
 * pinged to rework; rejected → bond goes to the agent (anti-abuse).
 */
export default function DisputeModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const { signer } = useWallet();
  const [reason, setReason] = useState("");
  const [bond, setBond] = useState("2");
  const [phase, setPhase] = useState<"form" | "opening" | "judging" | "done">("form");
  const [verdict, setVerdict] = useState<{ upheld: boolean; juryNote: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    try {
      const disputeId = newTaskId();
      setPhase("opening");
      await openDispute({ disputeId, taskId: task.taskId, agent: task.assignedAgent!, bondUsdc: parseFloat(bond) || 0, reason: reason.trim() }, signer);
      setPhase("judging");
      const r = await resolveDispute(disputeId, reason.trim());
      if (r.error) throw new Error(r.error);
      setVerdict({ upheld: !!r.upheld, juryNote: r.juryNote || "" });
      setPhase("done");
    } catch (e) {
      setErr((e as Error).message || "Dispute failed");
      setPhase("form");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-white"><Scale size={15} className="text-violet" /> Dispute deliverable</div>
          <button onClick={onClose} className="text-grey hover:text-white"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          {phase === "done" && verdict ? (
            <div className="flex flex-col gap-3">
              <div className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold ${verdict.upheld ? "border-green/40 bg-green/5 text-green" : "border-red/40 bg-red/5 text-red"}`}>
                {verdict.upheld ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                Dispute {verdict.upheld ? "UPHELD — bond refunded, agent will rework" : "REJECTED — you forfeit 50% (30% agent, 20% treasury)"}
              </div>
              <div className="rounded-xl border border-border bg-deep p-3">
                <div className="eyebrow mb-1">AI jury verdict</div>
                <p className="text-sm leading-relaxed text-grey-l">{verdict.juryNote}</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed text-grey-l">
                The work passed verification but you can still challenge it. An impartial AI jury re-reads your brief
                against the delivery. <span className="text-white">If your dispute is rejected as unfair you forfeit 50% of the bond (30% to the agent, 20% to the treasury)</span> — so only dispute genuine misses.
              </p>
              <textarea className="input-field min-h-[90px]" placeholder="Why does the deliverable miss the brief?" value={reason} onChange={(e) => setReason(e.target.value)} />
              <label className="block">
                <div className="eyebrow mb-1.5">Dispute bond (USDC)</div>
                <input type="number" min="1" className="input-field" value={bond} onChange={(e) => setBond(e.target.value)} />
              </label>
              <div className="rounded-xl border border-border bg-deep p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-grey-l">At stake</span>
                  <USDCAmount amount={parseFloat(bond) || 0} size="sm" className="text-white" />
                </div>
              </div>
              {err && <p className="text-xs text-red">{err}</p>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          {phase === "done" ? (
            <button onClick={onClose} className="btn-primary btn-sm">Close</button>
          ) : (
            <>
              <button onClick={onClose} className="btn-ghost btn-sm" disabled={phase !== "form"}>Cancel</button>
              <button onClick={submit} disabled={phase !== "form" || !reason.trim() || !(parseFloat(bond) > 0)} className="btn-primary btn-sm">
                {phase === "opening" ? <><Loader2 size={13} className="animate-spin" /> Staking bond…</>
                  : phase === "judging" ? <><Loader2 size={13} className="animate-spin" /> Jury deliberating…</>
                  : <><Scale size={13} /> Stake bond & dispute</>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
