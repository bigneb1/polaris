import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Repeat, CalendarClock } from "lucide-react";
import { USDCAmount } from "./ui/primitives";
import { AgentAvatarImg } from "./AgentAvatar";
import { useWallet } from "../context/WalletProvider";
import { useTx } from "../hooks/useTx";
import { createSubscription, newTaskId } from "../lib/tx";
import type { Agent } from "../lib/types";
import { useAsset } from "../hooks/useAsset";

const DAYS = [
  { k: "mon", label: "Mon" },
  { k: "tue", label: "Tue" },
  { k: "wed", label: "Wed" },
  { k: "thu", label: "Thu" },
  { k: "fri", label: "Fri" },
  { k: "sat", label: "Sat" },
  { k: "sun", label: "Sun" },
];

/**
 * Subscribe to an agent for recurring deliveries. The whole plan
 * (perDelivery × deliveries) is escrowed up front; the runtime scheduler drops
 * one deliverable per scheduled slot and releases one slice on each.
 */
export default function SubscribeModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { symbol } = useAsset();
  const { address, signer } = useWallet();
  const { run, loading } = useTx();

  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const taskType = agent.capabilities[0] ?? "general";
  const [perDelivery, setPerDelivery] = useState("10");
  const [deliveries, setDeliveries] = useState("4");
  const [days, setDays] = useState<string[]>(["mon", "wed", "fri"]);
  const [time, setTime] = useState("09:00");

  const per = parseFloat(perDelivery) || 0;
  const count = parseInt(deliveries) || 0;
  const total = per * count;
  const schedule = `${days.join(",")}@${time}`;
  const valid = address && title.trim() && days.length > 0 && per > 0 && count > 0;

  const toggleDay = (k: string) => setDays((d) => (d.includes(k) ? d.filter((x) => x !== k) : [...d, k]));

  const subscribe = () =>
    run(
      () =>
        createSubscription(
          {
            subId: newTaskId(),
            agent: agent.wallet,
            perDeliveryUsdc: per,
            totalDeliveries: count,
            title: title.trim(),
            brief: brief.trim() || title.trim(),
            rubric: "Deliver the requested recurring work accurately, on-topic, and on schedule.",
            taskType,
            schedule,
          },
          signer,
        ),
      { pending: "Escrowing plan & subscribing…", success: "Subscribed - deliveries will arrive on schedule" },
    ).then((h) => h && onClose());

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="rounded-[4px] border border-border bg-card flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex min-w-0 items-center gap-2.5 text-sm font-semibold text-foreground">
            <AgentAvatarImg agent={agent} size={30} />
            <span className="truncate">Subscribe to {agent.name}</span>
          </div>
          <button onClick={onClose} className="shrink-0 text-muted-foreground hover:text-foreground"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-3">
            <input className="field" placeholder="What recurring work? e.g. Weekly market thread" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="field min-h-[70px]" placeholder="Details / topic / style for each drop" value={brief} onChange={(e) => setBrief(e.target.value)} />

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="field-label mb-1.5">Per delivery ({symbol})</div>
                <input type="number" min="1" className="field" value={perDelivery} onChange={(e) => setPerDelivery(e.target.value)} />
              </label>
              <label className="block">
                <div className="field-label mb-1.5"># of deliveries</div>
                <input type="number" min="1" className="field" value={deliveries} onChange={(e) => setDeliveries(e.target.value)} />
              </label>
            </div>

            <div>
              <div className="field-label mb-2 flex items-center gap-1.5"><CalendarClock size={12} /> Schedule</div>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d) => (
                  <button
                    key={d.k}
                    type="button"
                    onClick={() => toggleDay(d.k)}
                    className={`font-mono rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${
                      days.includes(d.k) ? "border-secondary bg-secondary/15 text-foreground" : "border-border bg-muted text-muted-foreground hover:text-muted-foreground"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <label className="mt-3 block">
                <div className="field-label mb-1.5">Time (UTC)</div>
                <input type="time" className="field" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            </div>

            <div className="rounded-xl border border-border bg-muted p-3 text-xs">
              <div className="flex items-center justify-between py-0.5">
                <span className="text-muted-foreground">Cadence</span>
                <span className="font-mono text-foreground">{days.length ? `${days.length}× · ${schedule}` : "pick days"}</span>
              </div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-muted-foreground">Escrowed now (whole plan)</span>
                <USDCAmount amount={total} size="sm" className="text-foreground" />
              </div>
              <p className="font-mono mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                Funds are held on-chain; one slice releases to the agent per verified delivery. Cancel anytime to refund the rest.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="tool-btn">Cancel</button>
          <button onClick={subscribe} disabled={!valid || loading} className="tool-btn-primary">
            <Repeat size={13} /> {loading ? "Subscribing…" : "Subscribe & escrow"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
