import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { Panel, EmptyState } from "./ui/primitives";
import { useWallet } from "../context/WalletProvider";
import { useTx } from "../hooks/useTx";
import { getRatings, submitRating, type AgentRatings } from "../lib/api";
import { shortAddr, timeAgo } from "../lib/utils";

function Stars({ value, onPick, size = 14 }: { value: number; onPick?: (n: number) => void; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          onClick={onPick ? () => onPick(n) : undefined}
          className={`${onPick ? "cursor-pointer" : ""} ${n <= Math.round(value) ? "fill-amber-300 text-amber-300" : "text-grey"}`}
        />
      ))}
    </span>
  );
}

/** Agent feedback & ratings (Phase C) — average, recent comments, and a submit form. */
export default function RatingsPanel({ wallet }: { wallet: string }) {
  const { address } = useWallet();
  const { run, loading } = useTx();
  const [data, setData] = useState<AgentRatings>({ ratings: [], avg: 0, count: 0 });
  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState("");

  const load = () => getRatings(wallet).then(setData);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [wallet]);

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Star size={14} /> Ratings
          {data.count > 0 && <span className="mono text-xs text-grey">· {data.avg.toFixed(1)} ({data.count})</span>}
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        {data.count > 0 ? (
          <div className="flex items-center gap-3">
            <Stars value={data.avg} size={16} />
            <span className="mono text-sm text-white">{data.avg.toFixed(1)}/5</span>
            <span className="mono text-[11px] text-grey">{data.count} rating{data.count > 1 ? "s" : ""}</span>
          </div>
        ) : (
          <EmptyState title="No ratings yet" message="Be the first to rate this agent's work." />
        )}

        {data.ratings.length > 0 && (
          <div className="flex flex-col gap-2">
            {data.ratings.slice(-5).reverse().map((r, i) => (
              <div key={i} className="rounded-lg border border-border bg-deep p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <Stars value={r.stars} />
                  <span className="mono text-[10px] text-grey">{shortAddr(r.rater)} · {timeAgo(r.atMs)}</span>
                </div>
                {r.comment && <p className="text-xs leading-relaxed text-grey-l">{r.comment}</p>}
              </div>
            ))}
          </div>
        )}

        {address && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <span className="eyebrow">Your rating</span>
              <Stars value={stars} onPick={setStars} size={16} />
            </div>
            <textarea className="input-field min-h-[56px]" placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button
              onClick={() =>
                run(async () => {
                  await submitRating(wallet, "", address, stars, comment.trim());
                  setComment("");
                  await load();
                  return "0x" as `0x${string}`;
                }, { pending: "Submitting rating…", success: "Thanks for your feedback" })
              }
              disabled={loading}
              className="btn-ghost btn-sm w-full"
            >
              Submit rating
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
