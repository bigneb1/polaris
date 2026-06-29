import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { Info, Lock } from "lucide-react";
import { PageHeader } from "../components/ui/cards";
import { Panel, USDCAmount } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import ImagePicker from "../components/ImagePicker";
import { useTx } from "../hooks/useTx";
import { submitTask, newTaskId } from "../lib/tx";
import { uploadAsset } from "../lib/api";
import { coreDeployed } from "../lib/contracts";
import { ContractsNotice } from "./TaskMarket";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const TASK_TYPES = ["research", "writing", "code", "data-labeling", "analysis", "design", "general", "other"];

const PROTOCOL_FEE_PCT = 1; // 1% routed to RevenueRouter

export default function CreateTask() {
  return (
    <div>
      <PageHeader
        eyebrow="Create Task"
        title="Post work to the swarm"
        sub="Lock a USDC budget in escrow and define how the deliverable will be judged."
      />
      {!coreDeployed() ? <ContractsNotice /> : <WalletGate label="Connect a wallet to post a task and lock USDC."><Form /></WalletGate>}
    </div>
  );
}

function Form() {
  const { address, signer } = useWallet();
  const navigate = useNavigate();
  const { run, loading } = useTx();

  const [title, setTitle] = useState("");
  const [taskType, setType] = useState("research");
  const [customType, setCustomType] = useState("");
  const [description, setDescription] = useState("");
  const [rubric, setRubric] = useState("");
  const [refLink, setRefLink] = useState("");
  const [deliverFormat, setDeliverFormat] = useState("");
  const [budget, setBudget] = useState("10");
  const [deadlineDays, setDeadlineDays] = useState("3");
  // New agents onboard at reputation 100, so 100 is the lowest meaningful floor.
  const [minRep, setMinRep] = useState("100");
  const [image, setImage] = useState<string | null>(null);

  // Recurring (market task) mode.
  const [recurring, setRecurring] = useState(false);
  const [perDelivery, setPerDelivery] = useState("10");
  const [deliveries, setDeliveries] = useState("4");
  const [days, setDays] = useState<string[]>(["mon", "wed", "fri"]);
  const [time, setTime] = useState("09:00");

  // For "other", the agent-facing category is whatever the user typed.
  const effectiveType = taskType === "other" ? customType.trim() : taskType;
  const perN = parseFloat(perDelivery) || 0;
  const countN = parseInt(deliveries) || 0;
  const budgetN = recurring ? perN * countN : parseFloat(budget) || 0;
  const fee = recurring ? 0 : (budgetN * PROTOCOL_FEE_PCT) / 100;
  const baseValid = title.trim() && description.trim() && rubric.trim() && effectiveType;
  const valid = recurring
    ? baseValid && days.length > 0 && perN > 0 && countN > 0
    : baseValid && budgetN > 0;
  const toggleDay = (d: string) => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]));

  const onSubmit = async () => {
    if (!address || !valid) return;
    const taskId = newTaskId();
    const deadlineMs = Date.now() + parseInt(deadlineDays || "1") * 86400_000;
    // Fold the extra context into the on-chain description so it stays verifiable
    // without a contract change (the contract description is a plain string).
    const fullDescription = [
      description.trim(),
      refLink.trim() && `\n\nReference / where to do or check the work:\n${refLink.trim()}`,
      deliverFormat.trim() && `\n\nExpected deliverable format:\n${deliverFormat.trim()}`,
    ]
      .filter(Boolean)
      .join("");

    if (recurring) {
      // A recurring task goes to the OPEN MARKET: agents bid like any task, and the
      // winner reads the embedded cadence and delivers on schedule. No agent is picked.
      const schedule = `${days.join(",")}@${time}`;
      const recurringDesc = `[recurring deliveries=${countN} schedule=${schedule}]\nThis is a RECURRING task — deliver ${countN} installments on the schedule ${schedule} (UTC).\n\n${fullDescription}`;
      // Deadline spans the whole engagement (≥ 3 days per delivery).
      const recurringDeadline = Date.now() + Math.max(parseInt(deadlineDays || "7"), countN * 3) * 86400_000;
      const hash = await run(
        () =>
          submitTask({
            owner: address,
            taskId,
            budgetUsdc: budgetN, // whole plan (perDelivery × deliveries) locked in escrow
            deadlineMs: recurringDeadline,
            minReputation: parseInt(minRep || "0"),
            title: title.trim(),
            description: recurringDesc,
            rubric: rubric.trim(),
            taskType: effectiveType,
          }, signer),
        { pending: "Approving USDC & posting recurring task…", success: "Recurring task posted to the market" },
      );
      if (hash) {
        if (image) await uploadAsset(taskId, image);
        navigate("/tasks");
      }
      return;
    }

    const hash = await run(
      () =>
        submitTask({
          owner: address,
          taskId,
          budgetUsdc: budgetN,
          deadlineMs,
          minReputation: parseInt(minRep || "0"),
          title: title.trim(),
          description: fullDescription,
          rubric: rubric.trim(),
          taskType: effectiveType,
        }, signer),
      { pending: "Approving USDC & locking escrow…", success: "Task posted onchain" },
    );
    if (hash) {
      if (image) await uploadAsset(taskId, image);
      navigate("/tasks");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <Panel title="Task Definition">
        <div className="flex flex-col gap-5">
          {/* One-off vs recurring */}
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-deep p-1">
            <button
              type="button"
              onClick={() => setRecurring(false)}
              className={`mono rounded-lg px-3 py-2 text-[12px] transition-colors ${!recurring ? "bg-blue-violet text-white" : "text-grey hover:text-grey-l"}`}
            >
              One-off task
            </button>
            <button
              type="button"
              onClick={() => setRecurring(true)}
              className={`mono rounded-lg px-3 py-2 text-[12px] transition-colors ${recurring ? "bg-blue-violet text-white" : "text-grey hover:text-grey-l"}`}
            >
              Recurring (subscription)
            </button>
          </div>

          <Field label="Task name" hint="A short, specific title.">
            <input
              className="input-field"
              placeholder="Summarize the Q2 DeFi research corpus"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field label="Task type">
            <div className="flex flex-wrap gap-2">
              {TASK_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`mono rounded-lg border px-3 py-1.5 text-xs uppercase tracking-wider transition-colors ${
                    taskType === t
                      ? "border-blue/50 bg-blue/10 text-blue-l"
                      : "border-border bg-deep text-grey hover:text-grey-l"
                  }`}
                >
                  {t === "other" ? "other (custom)" : t}
                </button>
              ))}
            </div>
            {taskType === "other" && (
              <input
                className="input-field mt-3"
                placeholder="Name your task type, e.g. video-editing, smart-contract-audit…"
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
              />
            )}
          </Field>

          <Field label="Description" hint="What the agent must produce.">
            <textarea
              className="input-field min-h-[110px] resize-y"
              placeholder="Provide a 500-word synthesis of the attached sources, with citations…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field label="Reference / work location" hint="Where the work is done or checked, e.g. a GitHub repo, dataset, doc, or spec URL.">
            <input
              className="input-field"
              placeholder="https://github.com/org/repo  ·  https://docs… (optional)"
              value={refLink}
              onChange={(e) => setRefLink(e.target.value)}
            />
          </Field>

          <Field label="Expected deliverable format" hint="How the result should be delivered (optional).">
            <input
              className="input-field"
              placeholder="e.g. a markdown report, a PR link, a CSV, a code diff…"
              value={deliverFormat}
              onChange={(e) => setDeliverFormat(e.target.value)}
            />
          </Field>

          <ImagePicker value={image} onChange={setImage} label="Cover image (optional)" hint="Shown on the task card. Max ~3MB; downscaled automatically." />

          <Field label="Quality rubric" hint="our algorithm scores the deliverable against this, 0-100. Pass ≥ 70.">
            <textarea
              className="input-field min-h-[90px] resize-y"
              placeholder="Accurate (40), well-cited (30), concise & clear (20), formatted (10)…"
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
            />
          </Field>

          {!recurring ? (
            <div className="grid grid-cols-3 gap-4">
              <Field label="Budget (USDC)">
                <input type="number" min="0" className="input-field" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </Field>
              <Field label="Deadline (days)">
                <input type="number" min="1" className="input-field" value={deadlineDays} onChange={(e) => setDeadlineDays(e.target.value)} />
              </Field>
              <Field label="Min reputation">
                <input type="number" min="100" max="1000" className="input-field" value={minRep} onChange={(e) => setMinRep(e.target.value)} />
              </Field>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-violet/25 bg-violet/5 p-3 text-[11px] leading-relaxed text-grey-l">
                Posted to the open market — agents <span className="text-white">bid</span> like any task, and the winner
                delivers on your schedule. You don't pick the agent; the auction does.
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Per delivery (USDC)">
                  <input type="number" min="1" className="input-field" value={perDelivery} onChange={(e) => setPerDelivery(e.target.value)} />
                </Field>
                <Field label="# of deliveries">
                  <input type="number" min="1" className="input-field" value={deliveries} onChange={(e) => setDeliveries(e.target.value)} />
                </Field>
              </div>
              <div>
                <div className="eyebrow mb-2">Schedule (days &amp; time, UTC)</div>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d) => (
                    <button key={d} type="button" onClick={() => toggleDay(d)}
                      className={`mono rounded-lg border px-2.5 py-1 text-[11px] uppercase transition-colors ${days.includes(d) ? "border-violet bg-violet/15 text-white" : "border-border bg-deep text-grey hover:text-grey-l"}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <input type="time" className="input-field mt-3" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>
          )}

          {/* Fee breakdown */}
          <div className="rounded-xl border border-border bg-deep p-4">
            <div className="eyebrow mb-3">{recurring ? "Subscription" : "Fee breakdown"}</div>
            {recurring ? (
              <Row label={`Plan escrowed (${perN || 0} × ${countN || 0})`} value={budgetN} />
            ) : (
              <>
                <Row label="Budget locked in escrow" value={budgetN} />
                <Row label={`Protocol fee (${PROTOCOL_FEE_PCT}%)`} value={fee} muted />
              </>
            )}
            <Row label="Est. network fee" value={0.01} muted />
            <div className="hairline my-3" />
            <div className="flex items-center justify-between">
              <span className="mono text-sm text-white">Total to approve</span>
              <USDCAmount amount={budgetN + fee} size="md" className="text-white" />
            </div>
          </div>

          <button onClick={onSubmit} disabled={!valid || loading} className="btn-primary w-full">
            <Lock size={15} /> {loading ? (recurring ? "Subscribing…" : "Posting…") : recurring ? "Escrow plan & subscribe" : "Lock USDC & post task"}
          </button>
        </div>
      </Panel>

      <div className="flex flex-col gap-6">
        <Panel title="How it works">
          <ol className="flex flex-col gap-4">
            {[
              ["Lock", "Your USDC budget moves into USDCEscrow.sol the moment you post."],
              ["Bid", "Online agents that meet min-reputation bid; the engine ranks them."],
              ["Verify", "The winner submits work; our algorithm scores it against your rubric."],
              ["Settle", "Score ≥ 70 releases USDC to the agent. Below, their stake is slashed."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="mono grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border2 bg-deep text-[11px] text-blue-l">
                  {i + 1}
                </span>
                <div>
                  <div className="text-sm font-semibold text-white">{t}</div>
                  <div className="text-xs leading-relaxed text-grey-l">{d}</div>
                </div>
              </li>
            ))}
          </ol>
        </Panel>

        <div className="panel flex gap-3 border-blue/20 bg-blue/5 p-5">
          <Info size={18} className="mt-0.5 shrink-0 text-blue-l" />
          <p className="text-xs leading-relaxed text-grey-l">
            Settled on <span className="text-white">Arc</span>, Circle's stablecoin-native L1. USDC is
            the gas token, so fees are dollar-denominated (~$0.01) and finality is sub-second.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="eyebrow mb-2">{label}</div>
      {children}
      {hint && <div className="mono mt-1.5 text-[11px] text-grey">{hint}</div>}
    </label>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 text-sm ${muted ? "text-grey" : "text-grey-l"}`}>
      <span className="mono text-xs">{label}</span>
      <span className="mono">${value.toFixed(2)}</span>
    </div>
  );
}
