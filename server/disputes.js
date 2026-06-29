import { ethers } from "ethers";
import fs from "node:fs";
import { provider, ADDR, ABI, readTaskMeta } from "./chain.js";
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
  return { upheld, juryNote, txHash: tx.hash };
}
