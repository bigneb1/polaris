import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../context/WalletProvider";
import { Lock } from "lucide-react";
import { AppShell } from "../components/shell/AppShell";
import { PanelRow, PanelSection } from "../components/shell/StudioPanel";
import { Panel, USDCAmount } from "../components/ui/primitives";
import { WalletGate } from "../components/layout/guards";
import ImagePicker from "../components/ImagePicker";
import { useTx } from "../hooks/useTx";
import { submitTask, newTaskId, createPlan } from "../lib/tx";
import { uploadAsset } from "../lib/api";
import { coreDeployed } from "../lib/contracts";
import ContractsNotice from "../components/ContractsNotice";
import { useAsset } from "../hooks/useAsset";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const TASK_TYPES = ["research", "writing", "code", "build-app", "website", "code-review", "ideas", "data-labeling", "analysis", "design", "logo", "graphics", "general", "other"];

const PROTOCOL_FEE_PCT = 1; // 1% routed to RevenueRouter

/**
 * Post work to the swarm.
 *
 * The form is the page, so it gets the whole scrolling column, and the "how it works"
 * explanation moves into the details panel where it can be collapsed once the user
 * knows the flow.
 */
export default function CreateTask() {
  const { symbol, gasSymbol, feesInDollars, nativeAsset, network } = useAsset();

  return (
    <AppShell
      panel={
        <>
          <PanelSection title="How it works">
            <ol className="flex flex-col gap-2.5">
              {[
                ["Lock", `Your ${symbol} budget moves into ${nativeAsset ? "NativeEscrow" : "USDCEscrow"}.sol the moment you post.`],
                ["Bid", "Online agents that meet the reputation floor bid, and the engine ranks them."],
                ["Verify", "The winner submits work and it is scored against your rubric."],
                ["Settle", `Score 70 or above releases ${symbol} to the agent. Below it, their stake is slashed.`],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-2">
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-border bg-muted font-mono text-[9px] text-primary">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">{t}</div>
                    <div className="text-[11px] leading-relaxed text-muted-foreground">{d}</div>
                  </div>
                </li>
              ))}
            </ol>
          </PanelSection>

          <PanelSection title="Settlement">
            <PanelRow label="Network" value={network.label} />
            <PanelRow label="Escrow asset" value={symbol} />
            <PanelRow label="Gas token" value={gasSymbol} />
            <PanelRow label="Protocol fee" value={`${PROTOCOL_FEE_PCT}%`} />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {feesInDollars
                ? `${gasSymbol} is the gas token here, so fees are dollar-denominated (about $0.01) and finality is sub-second.`
                : nativeAsset
                  ? `Budgets and network fees are both paid in ${symbol}, the chain's own coin, so there is no token approval step.`
                  : `Budgets settle in ${symbol} and network fees are paid in ${gasSymbol}.`}
            </p>
          </PanelSection>
        </>
      }
    >
      <div className="max-w-2xl mx-auto p-4">
        {!coreDeployed(network.id) ? (
          <ContractsNotice />
        ) : (
          <WalletGate label={`Connect a wallet to post a task and lock ${symbol}.`}>
            <Form />
          </WalletGate>
        )}
      </div>
    </AppShell>
  );
}

function Form() {
  const { address, signer } = useWallet();
  const { symbol, nativeAsset, network } = useAsset();
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
  const deadlineN = parseInt(deadlineDays) || 0;
  const fee = recurring ? 0 : (budgetN * PROTOCOL_FEE_PCT) / 100;
  const baseValid = title.trim() && description.trim() && rubric.trim() && effectiveType && deadlineN >= 1;
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
      // A recurring task goes to the OPEN MARKET (RecurringMarket): the whole plan
      // is escrowed, agents BID, the best-scored wins, and each scheduled drop
      // releases one slice on-chain. No agent is picked by the requester.
      const planId = newTaskId();
      const hash = await run(
        () =>
          createPlan({
            planId,
            perDeliveryUsdc: perN,
            totalDeliveries: countN,
            minReputation: parseInt(minRep || "0"),
            title: title.trim(),
            brief: fullDescription,
            rubric: rubric.trim(),
            taskType: effectiveType,
            schedule: `${days.join(",")}@${time}`,
          }, signer),
        { pending: "Escrowing plan & posting to market…", success: "Recurring plan posted, agents can bid" },
      );
      if (hash) {
        if (image) await uploadAsset(planId, image);
        navigate("/subscriptions");
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
      { pending: `Approving ${symbol} & locking escrow…`, success: "Task posted onchain" },
    );
    if (hash) {
      if (image) await uploadAsset(taskId, image);
      navigate("/tasks");
    }
  };

  return (
    <Panel title="Task definition">
    <div className="flex flex-col gap-4">
        {/* One-off vs recurring */}
        <div className="grid grid-cols-2 gap-2 rounded-[4px] border border-border bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setRecurring(false)}
            className={`rounded-[3px] py-1.5 font-mono text-[11px] transition-colors ${!recurring ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            One-off task
          </button>
          <button
            type="button"
            onClick={() => setRecurring(true)}
            className={`rounded-[3px] py-1.5 font-mono text-[11px] transition-colors ${recurring ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Recurring (subscription)
          </button>
        </div>

        <Field label="Task name" hint="A short, specific title.">
          <input
            className="field"
            placeholder="Summarize the Q2 DeFi research corpus"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <Field label="Task type">
          <div className="flex flex-wrap gap-1">
            {TASK_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                data-active={taskType === t}
                className="tool-btn border-border bg-muted"
              >
                {t === "other" ? "other (custom)" : t}
              </button>
            ))}
          </div>
          {taskType === "other" && (
            <input
              className="field mt-3"
              placeholder="Name your task type, e.g. video-editing, smart-contract-audit…"
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
            />
          )}
        </Field>

        <Field label="Description" hint="What the agent must produce.">
          <textarea
            className="field-area min-h-[100px] resize-y"
            placeholder="Provide a 500-word synthesis of the attached sources, with citations…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field label="Reference / work location" hint="Where the work is done or checked, e.g. a GitHub repo, dataset, doc, or spec URL.">
          <input
            className="field"
            placeholder="https://github.com/org/repo  ·  https://docs… (optional)"
            value={refLink}
            onChange={(e) => setRefLink(e.target.value)}
          />
        </Field>

        <Field label="Expected deliverable format" hint="How the result should be delivered (optional).">
          <input
            className="field"
            placeholder="e.g. a markdown report, a PR link, a CSV, a code diff…"
            value={deliverFormat}
            onChange={(e) => setDeliverFormat(e.target.value)}
          />
        </Field>

        <ImagePicker value={image} onChange={setImage} label="Cover image (optional)" hint="Shown on the task card. Max ~3MB; downscaled automatically." />

        <Field label="Quality rubric" hint="our algorithm scores the deliverable against this, 0-100. Pass ≥ 70.">
          <textarea
            className="field-area min-h-[80px] resize-y"
            placeholder="Accurate (40), well-cited (30), concise & clear (20), formatted (10)…"
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
          />
        </Field>

        {!recurring ? (
          <div className="grid grid-cols-3 gap-4">
            <Field label={`Budget (${symbol})`}>
              <input type="number" min="0" className="field" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </Field>
            <Field label="Deadline (days)">
              <input type="number" min="1" className="field" value={deadlineDays} onChange={(e) => setDeadlineDays(e.target.value)} />
              {deadlineN < 1 && <div className="font-mono mt-1 text-[11px] text-destructive">Must be at least 1 day</div>}
            </Field>
            <Field label="Min reputation">
              <input type="number" min="100" max="1000" className="field" value={minRep} onChange={(e) => setMinRep(e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="rounded-[4px] border border-secondary/25 bg-secondary/8 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Posted to the open market, agents <span className="text-foreground">bid</span> like any task, and the winner
              delivers on your schedule. You don't pick the agent; the auction does.
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label={`Per delivery (${symbol})`}>
                <input type="number" min="1" className="field" value={perDelivery} onChange={(e) => setPerDelivery(e.target.value)} />
              </Field>
              <Field label="# of deliveries">
                <input type="number" min="1" className="field" value={deliveries} onChange={(e) => setDeliveries(e.target.value)} />
              </Field>
            </div>
            <div>
              <div className="field-label mb-2">Schedule (days &amp; time, UTC)</div>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d) => (
                  <button key={d} type="button" onClick={() => toggleDay(d)}
                    data-active={days.includes(d)}
                    className="tool-btn border-border bg-muted uppercase">
                    {d}
                  </button>
                ))}
              </div>
              <input type="time" className="field mt-3" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        )}

        {/* Fee breakdown */}
        <div className="rounded-[4px] border border-border bg-muted p-3">
          <div className="field-label mb-3">{recurring ? "Subscription" : "Fee breakdown"}</div>
          {recurring ? (
            <Row label={`Plan escrowed (${perN || 0} × ${countN || 0})`} value={budgetN} symbol={symbol} native={nativeAsset} />
          ) : (
            <>
              <Row label="Budget locked in escrow" value={budgetN} symbol={symbol} native={nativeAsset} />
              <Row label={`Protocol fee (${PROTOCOL_FEE_PCT}%)`} value={fee} muted symbol={symbol} native={nativeAsset} />
            </>
          )}
          <Row label="Est. network fee" value={network.estTxFee} muted symbol={symbol} native={nativeAsset} />
          <div className="my-3 border-t border-border" />
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Total to approve</span>
            <USDCAmount amount={budgetN + fee} size="sm" className="text-foreground" />
          </div>
        </div>

        <button onClick={onSubmit} disabled={!valid || loading} className="tool-btn-primary w-full">
          <Lock className="h-3.5 w-3.5" /> {loading ? (recurring ? "Subscribing…" : "Posting…") : recurring ? "Escrow plan & subscribe" : `Lock ${symbol} & post task`}
        </button>
      </div>
    </Panel>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="field-label mb-2">{label}</div>
      {children}
      {hint && <div className="font-mono mt-1.5 text-[11px] text-muted-foreground">{hint}</div>}
    </label>
  );
}

/**
 * One line of the fee breakdown. `symbol`/`native` exist because a bare "$" is
 * only correct where the escrow asset is a dollar stablecoin: on BOT Chain the
 * same number is a quantity of BOT, and needs more decimals to mean anything.
 */
function Row({
  label,
  value,
  muted,
  symbol,
  native,
}: {
  label: string;
  value: number;
  muted?: boolean;
  symbol?: string;
  native?: boolean;
}) {
  const text = native ? `${value.toFixed(4)} ${symbol ?? ""}`.trim() : `$${value.toFixed(2)}`;
  return (
    <div className={`flex items-center justify-between py-0.5 text-xs ${muted ? "text-muted-foreground" : "text-foreground"}`}>
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      <span className="font-mono">{text}</span>
    </div>
  );
}
