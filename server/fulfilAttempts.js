/**
 * How many times an agent has tried and failed to fulfil a task.
 *
 * WHY THIS EXISTS. `fulfilWins` used to clear a failed task from its in-memory `handled`
 * set, which meant "retry on the next tick" with no ceiling. When the failure was permanent
 * for that task, the agent retried every ~20s indefinitely and paid for a model call each
 * time. Production showed it: one task looping while the model kept returning nothing, the
 * task pinned in ASSIGNED, and the requester's escrow locked behind it.
 *
 * A retry budget makes the failure terminal from the agent's side. Once it is spent the agent
 * stops spending money on that task and leaves it to the deadline reaper, which is the only
 * thing that can actually resolve it on chain.
 *
 * DURABLE on purpose. `handled` is in-memory, so a restart previously reset every count and
 * a permanently-failing task began burning credits again. The counts live with the other
 * off-chain stores, per chain, since a task id is only unique within a chain.
 */
import fs from "node:fs";
import { networkStorePath } from "./store-path.js";

/** Attempts allowed before an agent gives up on a task. */
export const FULFIL_MAX_ATTEMPTS = Number(process.env.FULFIL_MAX_ATTEMPTS || 3);

const cache = new Map(); // chainId -> { [taskId]: { n, lastError, lastAtMs } }

function file(chainId) {
  return networkStorePath(`FULFIL_ATTEMPTS_STORE_${chainId}`, "fulfil-attempts.json", { chainId });
}

function load(chainId) {
  let m = cache.get(chainId);
  if (!m) {
    try {
      m = JSON.parse(fs.readFileSync(file(chainId), "utf8"));
    } catch {
      m = {};
    }
    cache.set(chainId, m);
  }
  return m;
}

/**
 * Merges over what is on disk rather than replacing it. Several agents share one process and
 * one file, so a plain read-modify-write would let the last writer erase the others' counts,
 * which is the same lost-update bug the mintability cache had.
 */
function persist(chainId, map) {
  try {
    let onDisk = {};
    try {
      onDisk = JSON.parse(fs.readFileSync(file(chainId), "utf8"));
    } catch {
      /* first write */
    }
    const merged = { ...onDisk, ...map };
    cache.set(chainId, merged);
    fs.writeFileSync(file(chainId), JSON.stringify(merged));
  } catch {
    /* best effort: the in-memory count still bounds this process */
  }
}

const key = (taskId) => String(taskId).toLowerCase();

/** Attempts recorded so far. */
export function attemptsFor(chainId, taskId) {
  return load(chainId)[key(taskId)]?.n ?? 0;
}

/** True once the budget is spent and the agent should stop retrying. */
export function exhausted(chainId, taskId) {
  return attemptsFor(chainId, taskId) >= FULFIL_MAX_ATTEMPTS;
}

/** Record a failed attempt; returns the new count. */
export function recordFailure(chainId, taskId, error) {
  const map = load(chainId);
  const k = key(taskId);
  const n = (map[k]?.n ?? 0) + 1;
  map[k] = { n, lastError: String(error ?? "").slice(0, 300), lastAtMs: Date.now() };
  persist(chainId, map);
  return n;
}

/** Forget a task's failures once it succeeds, so the store does not grow without bound. */
export function clearFailures(chainId, taskId) {
  const map = load(chainId);
  const k = key(taskId);
  if (!(k in map)) return;
  delete map[k];
  try {
    let onDisk = {};
    try {
      onDisk = JSON.parse(fs.readFileSync(file(chainId), "utf8"));
    } catch {
      /* nothing to prune */
    }
    delete onDisk[k];
    cache.set(chainId, onDisk);
    fs.writeFileSync(file(chainId), JSON.stringify(onDisk));
  } catch {
    /* best effort */
  }
}

/** Test seam. */
export function resetFulfilAttemptsCache() {
  cache.clear();
}
