import { ethers } from "ethers";
import fs from "node:fs";
import { provider, ADDR, ABI, CHAIN_ID, readTaskMeta, queryLogsChunked } from "./chain.js";
import { adjudicateDispute, genlayerEnabled } from "./genlayer.js";
import { storePath } from "./store-path.js";

/**
 * AI jury + dispute resolution (Phase C).
 *
 * A requester opens a staked dispute on-chain; GenLayer's validator committee
 * acts as the jury, re-reading the request, work, rubric, and complaint. After
 * the GenLayer decision finalizes, this module relays it to Arc. Upheld → bond refunded to the requester; rejected →
 * bond paid to the agent (anti-abuse). The jury reasoning is recorded on-chain.
 */
const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;
const DELIVERABLE_STORE = storePath("DELIVERABLE_STORE", "deliverables.json");
const REWORK_STORE = storePath("REWORK_STORE", "reworks.json");

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

/** Resolve an open dispute: finalize the GenLayer jury, then settle on Arc. */
export async function resolveDispute(disputeId, complaint = "") {
  if (!SIGNER_KEY) throw new Error("VERIFIER_SIGNER_KEY not set");
  const reader = new ethers.Contract(ADDR.disputeManager, ABI.disputeManager, provider);
  const d = await reader.getDispute(disputeId);
  if (Number(d.status) !== 1) throw new Error("Dispute is not open");

  const meta = await readTaskMeta(d.taskId);
  const deliverable = loadDeliverable(d.taskId) || "(no deliverable on record)";
  const verdict = await adjudicateDispute({
    disputeId,
    taskId: d.taskId,
    requester: d.requester,
    agent: d.agent,
    title: meta?.title || "",
    description: meta?.description || "",
    rubric: meta?.rubric || "",
    deliverable,
    complaint: complaint || "(no written complaint provided)",
  });
  const upheld = !!verdict.upheld;
  const juryNote = String(verdict.reasoning || "").slice(0, 300);

  const wallet = new ethers.Wallet(SIGNER_KEY, provider);
  // Must match DisputeManager.resolveDispute's digest exactly (chain + contract
  // instance domain separation) — see docs/AUDIT_REPORT.md, Security #5.
  const inner = ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "bool", "bytes32"],
    [CHAIN_ID, ADDR.disputeManager, disputeId, upheld, verdict.adjudicationId],
  );
  const sig = await wallet.signMessage(ethers.getBytes(inner));
  const writer = new ethers.Contract(ADDR.disputeManager, ABI.disputeManager, wallet);
  const tx = await writer.resolveDispute(disputeId, upheld, juryNote, verdict.adjudicationId, sig);
  await tx.wait();
  // Upheld → queue the assigned agent to rework the task (picked up by the swarm).
  if (upheld) requestRework(d.taskId, juryNote);
  return {
    upheld, juryNote, txHash: tx.hash,
    genLayerDecisionId: verdict.adjudicationId,
    genlayerTxHash: verdict.genlayerTxHash,
  };
}

/**
 * Fallback auto-resolver: the frontend resolves a dispute right after opening it,
 * but if that request fails (RPC blip, closed tab) the dispute stays OPEN. This
 * scans recent DisputeOpened events and settles any still-open dispute, so the
 * jury verdict always lands even when the client didn't complete it.
 */
export function startDisputeResolver() {
  if (!SIGNER_KEY || !genlayerEnabled()) {
    console.log("[disputes] auto-resolver disabled (Arc relay signer or GenLayer adjudicator not configured)");
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
