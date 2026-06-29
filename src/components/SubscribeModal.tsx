import { useState } from "react";
import { X, Repeat, CalendarClock } from "lucide-react";
import { USDCAmount } from "./ui/primitives";
import { AgentAvatarImg } from "./AgentAvatar";
import { useWallet } from "../context/WalletProvider";
import { useTx } from "../hooks/useTx";
import { createSubscription, newTaskId } from "../lib/tx";
import type { Agent } from "../lib/types";

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

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-void/70 p-4 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="panel flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="inline-flex min-w-0 items-center gap-2.5 text-sm font-semibold text-white">
            <AgentAvatarImg agent={agent} size={30} />
            <span className="truncate">Subscribe to {agent.name}</span>
          </div>
          <button onClick={onClose} className="shrink-0 text-grey hover:text-white"><X size={18} /></button>
        </div>

        <div className="min-w-0 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-3">
            <input className="input-field" placeholder="What recurring work? e.g. Weekly thread on Arc" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="input-field min-h-[70px]" placeholder="Details / topic / style for each drop" value={brief} onChange={(e) => setBrief(e.target.value)} />

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="eyebrow mb-1.5">Per delivery (USDC)</div>
                <input type="number" min="1" className="input-field" value={perDelivery} onChange={(e) => setPerDelivery(e.target.value)} />
              </label>
              <label className="block">
                <div className="eyebrow mb-1.5"># of deliveries</div>
                <input type="number" min="1" className="input-field" value={deliveries} onChange={(e) => setDeliveries(e.target.value)} />
              </label>
            </div>

            <div>
              <div className="eyebrow mb-2 flex items-center gap-1.5"><CalendarClock size={12} /> Schedule</div>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d) => (
                  <button
                    key={d.k}
                    type="button"
                    onClick={() => toggleDay(d.k)}
                    className={`mono rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${
                      days.includes(d.k) ? "border-violet bg-violet/15 text-white" : "border-border bg-deep text-grey hover:text-grey-l"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <label className="mt-3 block">
                <div className="eyebrow mb-1.5">Time (UTC)</div>
                <input type="time" className="input-field" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            </div>

            <div className="rounded-xl border border-border bg-deep p-3 text-xs">
              <div className="flex items-center justify-between py-0.5">
                <span className="text-grey-l">Cadence</span>
                <span className="mono text-white">{days.length ? `${days.length}× · ${schedule}` : "pick days"}</span>
              </div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-grey-l">Escrowed now (whole plan)</span>
                <USDCAmount amount={total} size="sm" className="text-white" />
              </div>
              <p className="mono mt-1.5 text-[10px] leading-relaxed text-grey">
                Funds are held on-chain; one slice releases to the agent per verified delivery. Cancel anytime to refund the rest.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancel</button>
          <button onClick={subscribe} disabled={!valid || loading} className="btn-primary btn-sm">
            <Repeat size={13} /> {loading ? "Subscribing…" : "Subscribe & escrow"}
          </button>
        </div>
      </div>
    </div>
  );
}
