import { ethers } from "ethers";
import fs from "node:fs";
import { getChainCtx } from "./chain.js";
import { DEFAULT_NETWORK, getNetwork, isDeployed, scopedKey } from "./networks.js";
import { adjudicateDispute, genlayerEnabled } from "./genlayer.js";
import { disputeVerdictDigest } from "./digests.js";
import { storePath, writeJsonAtomic } from "./store-path.js";

/**
 * AI jury + dispute resolution (Phase C).
 *
 * A requester opens a staked dispute on-chain; GenLayer's validator committee sits
 * as the impartial jury, re-reading the original request against the delivered work
 * and the complaint. This module waits for that decision to FINALIZE, then signs the
 * verdict and calls resolveDispute on-chain (trusted-signer relay). Upheld → bond
 * refunded to the requester; rejected → bond split (agent + treasury) as anti-abuse.
 * The jury reasoning is recorded on-chain.
 *
 * MULTI-CHAIN: every entry point takes a network. The signed digest binds that
 * chain's id and DisputeManager address, so a verdict produced for one network is
 * unusable on another. Rework records are keyed by chain too — task ids are only
 * unique within a chain.
 */
const DELIVERABLE_STORE = storePath("DELIVERABLE_STORE", "deliverables.json");
const REWORK_STORE = storePath("REWORK_STORE", "reworks.json");

// ── Rework queue: an UPHELD dispute asks the assigned agent to redo the work.
// The swarm polls /api/reworks and re-produces the deliverable (real-time).
function loadReworks() {
  try {
    return JSON.parse(fs.readFileSync(REWORK_STORE, "utf8"));
  } catch {
    return {};
  }
}
function saveReworks(r) {
  try {
    writeJsonAtomic(REWORK_STORE, r);
  } catch {
    /* best-effort */
  }
}

/** Reworks pending on one network, keyed by bare task id (what the swarm expects). */
export function listReworks(networkId = DEFAULT_NETWORK) {
  const all = loadReworks();
  const out = {};
  for (const [key, rec] of Object.entries(all)) {
    // Legacy records (pre multi-chain) have no network and belong to Arc.
    const net = rec.network || DEFAULT_NETWORK;
    if (net !== networkId) continue;
    const taskId = String(rec.taskId || key).toLowerCase();
    out[taskId] = rec;
  }
  return out;
}

export function markReworkDone(networkId, taskId) {
  const r = loadReworks();
  const scoped = scopedKey(networkId, taskId);
  const legacy = String(taskId).toLowerCase();
  let changed = false;
  if (r[scoped]) {
    delete r[scoped];
    changed = true;
  }
  if (networkId === DEFAULT_NETWORK && r[legacy]) {
    delete r[legacy];
    changed = true;
  }
  if (changed) saveReworks(r);
}

function requestRework(networkId, taskId, feedback) {
  const r = loadReworks();
  r[scopedKey(networkId, taskId)] = {
    taskId,
    network: networkId,
    feedback: String(feedback || "").slice(0, 500),
    atMs: Date.now(),
  };
  saveReworks(r);
  console.log(`[disputes:${networkId}] rework requested for task ${taskId.slice(0, 10)}…`);
}

function loadDeliverable(networkId, taskId) {
  try {
    const store = JSON.parse(fs.readFileSync(DELIVERABLE_STORE, "utf8"));
    const scoped = store[scopedKey(networkId, taskId)];
    const legacy = networkId === DEFAULT_NETWORK ? store[String(taskId).toLowerCase()] : undefined;
    return (scoped ?? legacy)?.deliverable || null;
  } catch {
    return null;
  }
}

/** Resolve an open dispute: finalize the GenLayer jury, sign the verdict, settle on-chain. */
export async function resolveDispute(networkId, disputeId, complaint = "") {
  const ctx = getChainCtx(networkId);
  const wallet = ctx.signer();
  if (!wallet) throw new Error(`No verifier signer key configured for ${ctx.label}`);
  if (!ctx.ADDR.disputeManager) throw new Error(`DisputeManager isn't deployed on ${ctx.label}`);

  const reader = ctx.contract("disputeManager", "disputeManager");
  const d = await reader.getDispute(disputeId);
  if (Number(d.status) !== 1) throw new Error("Dispute is not open");

  const meta = await ctx.readTaskMeta(d.taskId);
  const deliverable = loadDeliverable(networkId, d.taskId) || "(no deliverable on record)";
  // Blocks until GenLayer validators reach consensus AND the decision finalizes.
  // Everything below settles money on that decision, so there is no partial path:
  // a failed adjudication throws and the dispute stays OPEN for the auto-resolver.
  const verdict = await adjudicateDispute(ctx, {
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

  // Must match DisputeManager.resolveDispute's digest exactly (chain + contract
  // instance domain separation) — see docs/AUDIT_REPORT.md, Security #5. Using
  // this network's chain id and manager address is what makes a verdict
  // unusable on any other deployment.
  const inner = disputeVerdictDigest(ctx, { disputeId, upheld, genLayerDecisionId: verdict.adjudicationId });
  const sig = await wallet.signMessage(ethers.getBytes(inner));
  const writer = ctx.contract("disputeManager", "disputeManager", wallet);
  // Pre-GenLayer deployments have no room for the decision id in the call. The
  // adjudication and its mirrored receipt still happened — only the on-chain record
  // of WHICH decision settled the bond has to wait for that network's redeploy.
  const tx = ctx.genlayerDecisionBinding
    ? await writer.resolveDispute(disputeId, upheld, juryNote, verdict.adjudicationId, sig)
    : await writer.resolveDispute(disputeId, upheld, juryNote, sig);
  await tx.wait();
  // Upheld → queue the assigned agent to rework the task (picked up by the swarm).
  if (upheld) requestRework(networkId, d.taskId, juryNote);
  return {
    upheld,
    juryNote,
    txHash: tx.hash,
    network: networkId,
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
export function startDisputeResolver(networkId = DEFAULT_NETWORK) {
  const ctx = getChainCtx(networkId);
  if (!isDeployed(networkId) || !ctx.ADDR.disputeManager) {
    console.log(`[disputes:${networkId}] auto-resolver disabled (DisputeManager not deployed)`);
    return;
  }
  if (!ctx.signer()) {
    console.log(`[disputes:${networkId}] auto-resolver disabled (no signer key)`);
    return;
  }
  // Without a GenLayer operator there is no jury, so every tick would open a
  // dispute, throw, and retry forever. Say so once instead.
  if (!genlayerEnabled()) {
    console.log(`[disputes:${networkId}] auto-resolver disabled (GenLayer adjudicator not configured)`);
    return;
  }
  const reader = ctx.contract("disputeManager", "disputeManager");
  const POLL = Number(process.env.DISPUTE_POLL_MS || 60000);
  const LOOKBACK = Number(process.env.DISPUTE_LOOKBACK_BLOCKS || 100000);
  const tick = async () => {
    try {
      const opened = await ctx.queryLogsChunked(reader, reader.filters.DisputeOpened(), LOOKBACK);
      for (const log of opened) {
        const id = log.args.disputeId;
        try {
          const d = await reader.getDispute(id);
          if (Number(d.status) !== 1) continue; // already resolved
          console.log(`[disputes:${networkId}] auto-resolving ${id.slice(0, 10)}…`);
          await resolveDispute(networkId, id, log.args.reason || "");
        } catch {
          /* transient (RPC / not-open race) — retry next tick */
        }
      }
    } catch (e) {
      console.error(`[disputes:${networkId}] resolver tick error:`, e.message);
    }
  };
  tick();
  setInterval(tick, POLL).unref();
  console.log(`[disputes:${networkId}] auto-resolver on · every ${POLL / 1000}s · ${getNetwork(networkId).label}`);
}
