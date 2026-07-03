import { ethers } from "ethers";
import fs from "node:fs";
import { provider, ADDR, ABI, readTaskMeta, queryLogsChunked } from "./chain.js";
import { chat } from "./llm.js";

/**
 * AI jury + dispute resolution (Phase C).
 *
 * A requester opens a staked dispute on-chain; this module runs an impartial LLM
 * jury that re-reads the original request vs the delivered work and the
 * complaint, then signs the verdict and calls resolveDispute on-chain
 * (trusted-signer model). Upheld → bond refunded to the requester; rejected →
 * bond paid to the agent (anti-abuse). The jury reasoning is recorded on-chain.
 */
const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;
const DELIVERABLE_STORE = process.env.DELIVERABLE_STORE || "./deliverables.json";
const REWORK_STORE = process.env.REWORK_STORE || "/data/reworks.json";

// ── Rework queue: an UPHELD dispute asks the assigned agent to redo the work.
// The swarm polls /api/reworks and re-produces the deliverable (real-time).
function loadReworks() {
  try { return JSON.parse(fs.readFileSync(REWORK_STORE, "utf8")); } catch { return {}; }
}
function saveReworks(r) {
  try { fs.writeFileSync(REWORK_STORE, JSON.stringify(r)); } catch { /* best-effort */ }
}
export function listReworks() { return loadReworks(); }
export function markReworkDone(taskId) {
  const r = loadReworks();
  if (r[taskId.toLowerCase()]) { delete r[taskId.toLowerCase()]; saveReworks(r); }
}
function requestRework(taskId, feedback) {
  const r = loadReworks();
  r[taskId.toLowerCase()] = { taskId, feedback: String(feedback || "").slice(0, 500), atMs: Date.now() };
  saveReworks(r);
  console.log(`[disputes] rework requested for task ${taskId.slice(0, 10)}…`);
}

function loadDeliverable(taskId) {
  try {
    return JSON.parse(fs.readFileSync(DELIVERABLE_STORE, "utf8"))[taskId.toLowerCase()]?.deliverable || null;
  } catch {
    return null;
  }
}

export async function runJury({ title, description, rubric, deliverable, complaint }) {
  const sys =
    "You are an impartial 3-member AI jury for an autonomous task marketplace. " +
    "Decide whether the requester's dispute is VALID: does the delivered work genuinely " +
    "fail to meet the original request and rubric? Be fair to both sides — a vague or " +
    "unfair complaint must be rejected; a deliverable that truly misses the brief must be " +
    'upheld. Respond ONLY as JSON: {"upheld": boolean, "reasoning": string}. Keep reasoning to 2-3 sentences.';
  const user =
    `ORIGINAL REQUEST\nTitle: ${title}\nDescription: ${description}\nRubric: ${rubric}\n\n` +
    `DELIVERED WORK\n${deliverable}\n\nREQUESTER'S COMPLAINT\n${complaint}`;
  const out = await chat([{ role: "system", content: sys }, { role: "user", content: user }], { json: true, maxTokens: 400 });
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = { upheld: false, reasoning: "Jury output unparseable; dispute rejected by default." };
  }
  return { upheld: !!parsed.upheld, juryNote: String(parsed.reasoning || "").slice(0, 300) };
}

/** Resolve an open dispute: run the jury, sign the verdict, settle on-chain. */
export async function resolveDispute(disputeId, complaint = "") {
  if (!SIGNER_KEY) throw new Error("VERIFIER_SIGNER_KEY not set");
  const reader = new ethers.Contract(ADDR.disputeManager, ABI.disputeManager, provider);
  const d = await reader.getDispute(disputeId);
  if (Number(d.status) !== 1) throw new Error("Dispute is not open");

  const meta = await readTaskMeta(d.taskId);
  const deliverable = loadDeliverable(d.taskId) || "(no deliverable on record)";
  const { upheld, juryNote } = await runJury({
    title: meta?.title || "",
    description: meta?.description || "",
    rubric: meta?.rubric || "",
    deliverable,
    complaint: complaint || "(no written complaint provided)",
  });

  const wallet = new ethers.Wallet(SIGNER_KEY, provider);
  const inner = ethers.solidityPackedKeccak256(["bytes32", "bool"], [disputeId, upheld]);
  const sig = await wallet.signMessage(ethers.getBytes(inner));
  const writer = new ethers.Contract(ADDR.disputeManager, ABI.disputeManager, wallet);
  const tx = await writer.resolveDispute(disputeId, upheld, juryNote, sig);
  await tx.wait();
  // Upheld → queue the assigned agent to rework the task (picked up by the swarm).
  if (upheld) requestRework(d.taskId, juryNote);
  return { upheld, juryNote, txHash: tx.hash };
}

/**
 * Fallback auto-resolver: the frontend resolves a dispute right after opening it,
 * but if that request fails (RPC blip, closed tab) the dispute stays OPEN. This
 * scans recent DisputeOpened events and settles any still-open dispute, so the
 * jury verdict always lands even when the client didn't complete it.
 */
export function startDisputeResolver() {
  if (!SIGNER_KEY) {
    console.log("[disputes] auto-resolver disabled (VERIFIER_SIGNER_KEY not set)");
    return;
  }
  const reader = new ethers.Contract(ADDR.disputeManager, ABI.disputeManager, provider);
  const POLL = Number(process.env.DISPUTE_POLL_MS || 60000);
  const LOOKBACK = Number(process.env.DISPUTE_LOOKBACK_BLOCKS || 100000);
  const tick = async () => {
    try {
      const opened = await queryLogsChunked(reader, reader.filters.DisputeOpened(), LOOKBACK);
      for (const log of opened) {
        const id = log.args.disputeId;
        try {
          const d = await reader.getDispute(id);
          if (Number(d.status) !== 1) continue; // already resolved
          console.log(`[disputes] auto-resolving ${id.slice(0, 10)}…`);
          await resolveDispute(id, log.args.reason || "");
        } catch {
          /* transient (RPC / not-open race) — retry next tick */
        }
      }
    } catch (e) {
      console.error("[disputes] resolver tick error:", e.message);
    }
  };
  tick();
  setInterval(tick, POLL).unref();
  console.log(`[disputes] auto-resolver on · every ${POLL / 1000}s`);
}
