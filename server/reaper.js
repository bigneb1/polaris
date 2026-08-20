/**
 * The terminal-state guarantee: no task may sit in a working state forever.
 *
 * WHY THIS EXISTS. `NativeTaskRegistry.slashOnTimeout` (and Arc's equivalent) is deliberately
 * permissionless — "anyone can enforce a missed deadline" — and refunds the requester while
 * slashing the agent that missed it. Nothing called it. The contracts shipped the escape
 * hatch and the runtime never used it, so an ASSIGNED task whose agent never delivered stayed
 * ASSIGNED past its deadline permanently, with the requester's budget locked in escrow. That
 * is what "stuck in progress" actually was.
 *
 * WHAT IT DOES NOT DO. An OPEN task past its deadline is not resolvable here: only the
 * requester may `cancelTask`, and adding an authorised expiry would need a contract change
 * that Arc's live deployment cannot take. Those are surfaced in the UI as expired with the
 * requester's own refund action instead of being quietly left to look healthy.
 *
 * COST DISCIPLINE. Reads come from the checkpointed index, never a fresh log scan: this is
 * the same rate-limited RPC whose throttling once left production serving 4 tasks out of 270.
 * A tick with nothing to do costs one cached index read and no chain calls at all.
 */
import { ethers } from "ethers";
import { getChainCtx } from "./chain.js";
import { getNetwork, isDeployed, signerKeyFor } from "./networks.js";
import { getIndex } from "./indexer.js";
import fs from "node:fs";
import { storePath, writeJsonAtomic } from "./store-path.js";

/** How often to look. Deadlines are hours apart, so this does not need to be eager. */
const POLL_MS = Number(process.env.REAPER_POLL_MS || 120000);

/**
 * Grace period past the deadline before enforcing.
 *
 * Block timestamps and the indexer's clock are not the same clock, and `slashOnTimeout`
 * requires `block.timestamp > deadline` strictly. Enforcing the instant our own clock passes
 * the deadline would just produce "Before deadline" reverts, so wait out the skew.
 */
const GRACE_MS = Number(process.env.REAPER_GRACE_MS || 60000);

/** On-chain Status enum: OPEN, ASSIGNED, IN_PROGRESS, COMPLETED, SETTLED, CANCELLED. */
const STATUS = { OPEN: 0, ASSIGNED: 1, IN_PROGRESS: 2, COMPLETED: 3, SETTLED: 4, CANCELLED: 5 };
/** The states a deadline can be enforced from, matching the contract's own require(). */
const ENFORCEABLE = new Set([STATUS.ASSIGNED, STATUS.IN_PROGRESS]);

/** Reverts that mean "nothing to do", not "something went wrong". */
const BENIGN = /Before deadline|Not in progress/i;

/**
 * Deadlines before this are not enforced.
 *
 * WHY A CUTOFF EXISTS AT ALL. Enforcement was missing for the whole life of the deployment, so
 * switching it on found a backlog: 114 tasks on Arc, some 40 days overdue, holding 218 USDC.
 * `slashOnTimeout` refunds and slashes atomically, so clearing that backlog would have slashed
 * four agents 114 times between them and taken three of them to reputation 0 and roughly 1-3
 * USDC of stake, below the minimum and below BidEngine's bid floor of 70. They would never bid
 * again.
 *
 * Those tasks failed because nothing enforced deadlines, which is this bug, not because the
 * agents misbehaved. Punishing them retroactively for our own missing component would be
 * both unjust and self-defeating. So enforcement applies to deadlines that pass from the
 * moment it ships, and the backlog is left alone: still visible, and now labelled Overdue in
 * the UI rather than dressed up as "In progress".
 *
 * Set REAPER_ENFORCE_FROM_MS=0 to enforce the backlog too, deliberately and with the
 * consequences above in view.
 */
function resolveEnforceFrom() {
  const raw = process.env.REAPER_ENFORCE_FROM_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  // PERSISTED, not recomputed. The first version returned `Date.now()` at import time and
  // called a restart "the safe direction, it can only decline to punish". That is true about
  // punishment and false about the guarantee: every deploy moved the line forward, so a task
  // whose deadline passed while the runtime was restarting fell permanently outside
  // enforcement and could never be reaped. With frequent deploys that window is routine, and
  // it quietly downgraded "a task can never get stuck" to "usually doesn't" — the exact
  // failure this module exists to prevent.
  //
  // Stamping it once and reading it back makes it a real one-time grandfather line.
  const file = storePath("REAPER_ENFORCE_FROM_STORE", "reaper-enforce-from.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(saved?.enforceFromMs)) return saved.enforceFromMs;
  } catch {
    /* first run on this volume */
  }
  const stamped = Date.now();
  try {
    writeJsonAtomic(file, { enforceFromMs: stamped, stampedAtIso: new Date(stamped).toISOString() });
  } catch {
    // Cannot persist: fall back to enforcing everything rather than silently grandfathering
    // an unbounded backlog. Refusing to enforce is the failure that strands escrow.
    return 0;
  }
  return stamped;
}

const ENFORCE_FROM_MS = resolveEnforceFrom();

/**
 * Tasks the index believes are working and overdue.
 *
 * Deliberately derived from the index rather than the chain: the chain is consulted once per
 * candidate, immediately before acting, which is where the authoritative check belongs.
 */
export function overdueCandidates(
  index,
  { now = Date.now(), graceMs = GRACE_MS, enforceFromMs = ENFORCE_FROM_MS } = {},
) {
  const cutoff = now - graceMs;
  return (index?.tasks ?? []).filter(
    (t) =>
      (t.status === "ASSIGNED" || t.status === "IN_PROGRESS") &&
      t.deadlineMs &&
      t.deadlineMs < cutoff &&
      t.deadlineMs >= enforceFromMs,
  );
}

/** What the reaper is currently willing to enforce, for logging and tests. */
export function enforceFromMs() {
  return ENFORCE_FROM_MS;
}

/**
 * Enforce one task's deadline. Returns what happened, so a caller (and a test) can tell a
 * no-op from a real enforcement without reading logs.
 */
export async function enforceDeadline(ctx, registry, task) {
  // Re-read on chain before sending. The index can be a couple of minutes stale, and paying
  // gas to be told the task already settled is avoidable.
  const onChain = await registry.tasks(task.taskId);
  const status = Number(onChain.status);
  if (!ENFORCEABLE.has(status)) return { taskId: task.taskId, action: "skipped", reason: `status ${status}` };

  const deadlineMs = Number(onChain.deadline) * 1000;
  if (deadlineMs >= Date.now()) return { taskId: task.taskId, action: "skipped", reason: "before deadline" };

  try {
    const tx = await registry.slashOnTimeout(task.taskId);
    await tx.wait();
    return { taskId: task.taskId, action: "timed-out", txHash: tx.hash };
  } catch (e) {
    const msg = e.shortMessage || e.message || "";
    // Another caller (anyone may) got there first, or the clocks disagreed. Not an error.
    if (BENIGN.test(msg)) return { taskId: task.taskId, action: "skipped", reason: msg };
    return { taskId: task.taskId, action: "failed", reason: msg };
  }
}

/** One pass. Exported so a test can drive it without a timer. */
export async function reapOnce(networkId) {
  const key = signerKeyFor(networkId);
  if (!key) return { network: networkId, skipped: "no signer key configured" };

  const ctx = getChainCtx(networkId);
  if (!ctx.ADDR.taskRegistry) return { network: networkId, skipped: "no task registry" };

  const index = await getIndex(networkId);
  const candidates = overdueCandidates(index);
  if (candidates.length === 0) return { network: networkId, checked: 0, results: [] };

  // `slashOnTimeout` is permissionless, so the verdict signer is enough. No owner key is
  // involved, which is the point of having split them.
  const wallet = new ethers.Wallet(key, ctx.provider);
  const registry = new ethers.Contract(ctx.ADDR.taskRegistry, ctx.ABI.taskRegistry, wallet);

  const results = [];
  for (const task of candidates) {
    results.push(await enforceDeadline(ctx, registry, task));
  }
  return { network: networkId, checked: candidates.length, results };
}

/** Start the per-network ticker, in the shape the other services use. */
export function startReaper(networkId) {
  if (!isDeployed(networkId)) return;
  const label = getNetwork(networkId).label;

  const tick = async () => {
    try {
      const out = await reapOnce(networkId);
      for (const r of out.results ?? []) {
        if (r.action === "timed-out") {
          console.log(`[reaper:${networkId}] ${r.taskId.slice(0, 10)} passed its deadline → refunded requester, slashed agent (${r.txHash})`);
        } else if (r.action === "failed") {
          console.error(`[reaper:${networkId}] ${r.taskId.slice(0, 10)} enforcement failed: ${r.reason}`);
        }
      }
    } catch (e) {
      console.error(`[reaper:${networkId}] tick error:`, e.message);
    }
  };

  tick();
  setInterval(tick, POLL_MS).unref();
  console.log(
    `[reaper:${networkId}] deadline enforcement on · every ${POLL_MS / 1000}s · ${label} · ` +
      `enforcing deadlines from ${new Date(ENFORCE_FROM_MS).toISOString()} (earlier ones are grandfathered)`,
  );
}
