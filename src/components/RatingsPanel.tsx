import { useEffect, useState } from "react";
import { Star, PencilLine } from "lucide-react";
import { Panel, ProgressBar } from "./ui/primitives";
import { useWallet } from "../context/WalletProvider";
import { useTx } from "../hooks/useTx";
import { getRatings, submitRating, type AgentRatings } from "../lib/api";
import { shortAddr, timeAgo } from "../lib/utils";
import type { Task } from "../lib/types";

function Stars({ value, onPick, size = 14 }: { value: number; onPick?: (n: number) => void; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          onClick={onPick ? () => onPick(n) : undefined}
          className={`${onPick ? "cursor-pointer transition-transform hover:scale-110" : ""} ${n <= Math.round(value) ? "fill-amber-300 text-amber-300" : "text-grey/50"}`}
        />
      ))}
    </span>
  );
}

/**
 * Play-Store-style agent reviews (Phase C): a big average with rating-distribution
 * bars, a write-a-review composer (pick stars + write text), and the review list.
 *
 * A review must reference a real, settled task the connected wallet posted and
 * this agent completed — the backend independently verifies this on-chain
 * (server/server.js, /api/rating), so `myCompletedTasks` here is a UX
 * convenience (picking which of your settled tasks to review), not the
 * security boundary. See docs/AUDIT_REPORT.md, Bug #3.
 */
export default function RatingsPanel({ wallet, myCompletedTasks }: { wallet: string; myCompletedTasks: Task[] }) {
  const { address } = useWallet();
  const { run, loading } = useTx();
  const [data, setData] = useState<AgentRatings>({ ratings: [], avg: 0, count: 0 });
  const [writing, setWriting] = useState(false);
  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState("");
  // Not synced via effect (avoids a cascading-render lint issue): an explicit
  // pick overrides the default, but if it no longer refers to one of the
  // caller's completed tasks (list changed), fall back to the first one.
  const [taskIdPick, setTaskIdPick] = useState("");
  const taskId = myCompletedTasks.some((t) => t.taskId === taskIdPick) ? taskIdPick : (myCompletedTasks[0]?.taskId ?? "");

  const load = () => getRatings(wallet).then(setData);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [wallet]);

  // 5★→1★ distribution
  const dist = [5, 4, 3, 2, 1].map((s) => ({ s, n: data.ratings.filter((r) => Math.round(r.stars) === s).length }));

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Star size={14} /> Ratings &amp; reviews</span>}>
      <div className="flex flex-col gap-5">
        {/* Summary: big average + distribution bars */}
        <div className="flex items-center gap-5">
          <div className="text-center">
            <div className="text-4xl font-bold leading-none text-white">{data.count ? data.avg.toFixed(1) : "—"}</div>
            <div className="mt-1"><Stars value={data.avg} size={13} /></div>
            <div className="mono mt-1 text-[10px] text-grey">{data.count} review{data.count === 1 ? "" : "s"}</div>
          </div>
          <div className="flex-1">
            {dist.map(({ s, n }) => (
              <div key={s} className="flex items-center gap-2">
                <span className="mono w-3 text-[10px] text-grey">{s}</span>
                <Star size={9} className="fill-amber-300 text-amber-300" />
                <div className="flex-1"><ProgressBar value={data.count ? (n / data.count) * 100 : 0} /></div>
                <span className="mono w-5 text-right text-[10px] text-grey">{n}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Write a review — only possible once you have a settled task with this
            agent; the backend rejects anything else (see comment above). */}
        {address && myCompletedTasks.length > 0 && (
          writing ? (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-deep p-3">
              {myCompletedTasks.length > 1 && (
                <label className="block">
                  <div className="eyebrow mb-1.5">Which task?</div>
                  <select className="input-field" value={taskId} onChange={(e) => setTaskIdPick(e.target.value)}>
                    {myCompletedTasks.map((t) => (
                      <option key={t.taskId} value={t.taskId}>{t.title}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex items-center gap-3">
                <span className="eyebrow">Your rating</span>
                <Stars value={stars} onPick={setStars} size={20} />
              </div>
              <textarea className="input-field min-h-[70px]" placeholder="Share details of your experience with this agent" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setWriting(false)} className="btn-ghost btn-sm">Cancel</button>
                <button
                  onClick={() =>
                    run(async () => {
                      await submitRating(wallet, taskId, address, stars, comment.trim());
                      setComment(""); setWriting(false); await load();
                      return "0x" as `0x${string}`;
                    }, { pending: "Posting review…", success: "Review posted" })
                  }
                  disabled={loading || !taskId}
                  className="btn-primary btn-sm"
                >
                  Post review
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setWriting(true)} className="btn-ghost btn-sm w-full"><PencilLine size={13} /> Write a review</button>
          )
        )}
        {address && myCompletedTasks.length === 0 && (
          <p className="mono text-center text-[11px] text-grey">Complete a settled task with this agent to leave a review.</p>
        )}

        {/* Reviews */}
        {data.ratings.length > 0 && (
          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            {data.ratings.slice().reverse().slice(0, 8).map((r, i) => (
              <div key={i} className="rounded-xl border border-border bg-deep p-3">
                <div className="mb-1 flex items-center justify-between">
                  <Stars value={r.stars} />
                  <span className="mono text-[10px] text-grey">{shortAddr(r.rater)} · {timeAgo(r.atMs)}</span>
                </div>
                {r.comment && <p className="text-[13px] leading-relaxed text-grey-l">{r.comment}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
