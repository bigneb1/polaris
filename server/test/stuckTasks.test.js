import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A task must never be able to get stuck.
 *
 * Three defects conspired to pin a task in ASSIGNED forever, and each is pinned here.
 *
 * 1. `chat()` ended with `?? ""`, so a model that returned no content produced an empty
 *    deliverable. The deliverable endpoint refused it with a 400, the agent treated the 400
 *    as retryable, and it retried every ~20s indefinitely, paying for a model call each pass.
 * 2. The fulfil path had no retry ceiling at all.
 * 3. Nothing ever called `slashOnTimeout`, the permissionless escape hatch the contracts
 *    provide, so a task whose agent never delivered stayed ASSIGNED past its deadline with
 *    the requester's budget locked in escrow.
 */

process.env.POLARIS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-stuck-"));

/* ── 1. An empty completion is a failure ──────────────────────────────────────── */

let fetchImpl = null;
globalThis.fetch = (...a) => fetchImpl(...a);

const okBody = (content) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
});

process.env.OPENROUTER_API_KEY = "test-key";
process.env.LLM_RETRIES = "0";
const { chat } = await import("../llm.js");

test("an empty completion throws instead of becoming an empty deliverable", async () => {
  fetchImpl = async () => okBody("");
  await assert.rejects(() => chat([{ role: "user", content: "hi" }]), /empty completion/i);
});

test("a whitespace-only completion is also a failure", async () => {
  fetchImpl = async () => okBody("   \n\t ");
  await assert.rejects(() => chat([{ role: "user", content: "hi" }]), /empty completion/i);
});

test("a missing content field is a failure, not undefined", async () => {
  fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {} }] }) });
  await assert.rejects(() => chat([{ role: "user", content: "hi" }]), /empty completion/i);
});

test("a real completion still comes back untouched", async () => {
  fetchImpl = async () => okBody("the actual deliverable");
  assert.equal(await chat([{ role: "user", content: "hi" }]), "the actual deliverable");
});

/* ── 2. The fulfil retry budget ───────────────────────────────────────────────── */

const { attemptsFor, clearFailures, exhausted, recordFailure, FULFIL_MAX_ATTEMPTS, resetFulfilAttemptsCache } =
  await import("../fulfilAttempts.js");

test("an agent gives up after the retry budget instead of looping forever", () => {
  const task = "0xaaa1";
  assert.equal(exhausted(968, task), false);
  for (let i = 1; i < FULFIL_MAX_ATTEMPTS; i++) {
    recordFailure(968, task, "the model produced no usable deliverable");
    assert.equal(exhausted(968, task), false, `still within budget at ${i}`);
  }
  recordFailure(968, task, "again");
  assert.equal(exhausted(968, task), true, "budget spent, stop paying for this task");
});

test("the budget survives a restart, so a restart cannot resume the loop", () => {
  const task = "0xaaa2";
  for (let i = 0; i < FULFIL_MAX_ATTEMPTS; i++) recordFailure(968, task, "boom");
  resetFulfilAttemptsCache(); // as if the process restarted
  assert.equal(exhausted(968, task), true);
});

test("counts are per chain, because a task id is only unique within one", () => {
  const task = "0xaaa3";
  for (let i = 0; i < FULFIL_MAX_ATTEMPTS; i++) recordFailure(968, task, "boom");
  assert.equal(exhausted(968, task), true);
  assert.equal(exhausted(5042002, task), false);
});

test("success clears the record, so the store does not grow without bound", () => {
  const task = "0xaaa4";
  recordFailure(968, task, "transient");
  assert.equal(attemptsFor(968, task), 1);
  clearFailures(968, task);
  assert.equal(attemptsFor(968, task), 0);
});

test("concurrent failures on one chain do not overwrite each other", () => {
  // Several agents share one process and one file; a read-modify-write would lose entries.
  const tasks = ["0xbbb1", "0xbbb2", "0xbbb3"];
  for (const t of tasks) recordFailure(968, t, "boom");
  resetFulfilAttemptsCache();
  for (const t of tasks) assert.equal(attemptsFor(968, t), 1, `${t} survived`);
});

/* ── 3. The reaper ────────────────────────────────────────────────────────────── */

const HOUR = 3600_000;
mock.module("../indexer.js", { namedExports: { getIndex: async () => ({ tasks: [] }) } });
const { overdueCandidates, enforceDeadline } = await import("../reaper.js");

test("only non-terminal, past-deadline tasks are candidates", () => {
  const now = Date.now();
  const tasks = [
    { taskId: "0x1", status: "ASSIGNED", deadlineMs: now - 2 * HOUR },
    { taskId: "0x2", status: "IN_PROGRESS", deadlineMs: now - 2 * HOUR },
    { taskId: "0x3", status: "ASSIGNED", deadlineMs: now + 2 * HOUR }, // still has time
    { taskId: "0x4", status: "OPEN", deadlineMs: now - 2 * HOUR }, // requester-only to resolve
    { taskId: "0x5", status: "SETTLED", deadlineMs: now - 9 * HOUR }, // terminal
    { taskId: "0x6", status: "CANCELLED", deadlineMs: now - 9 * HOUR }, // terminal
  ];
  assert.deepEqual(overdueCandidates({ tasks }, { now }).map((t) => t.taskId), ["0x1", "0x2"]);
});

test("the grace period keeps us from fighting block-timestamp skew", () => {
  const now = Date.now();
  // Just barely past our clock: `slashOnTimeout` requires block.timestamp > deadline
  // strictly, so acting immediately would only earn a "Before deadline" revert.
  const tasks = [{ taskId: "0x1", status: "ASSIGNED", deadlineMs: now - 1000 }];
  assert.equal(overdueCandidates({ tasks }, { now, graceMs: 60000 }).length, 0);
  assert.equal(overdueCandidates({ tasks }, { now, graceMs: 0 }).length, 1);
});

/** A registry whose task status and revert behaviour the test controls. */
function registryStub({ status, deadlineSec, revert = null, sent = [] }) {
  return {
    sent,
    tasks: async () => ({ status, deadline: BigInt(deadlineSec) }),
    slashOnTimeout: async (taskId) => {
      if (revert) { const e = new Error(revert); throw e; }
      sent.push(taskId);
      return { hash: "0xtx", wait: async () => ({}) };
    },
  };
}

const past = Math.floor((Date.now() - 2 * HOUR) / 1000);
const future = Math.floor((Date.now() + 2 * HOUR) / 1000);

test("an overdue assigned task is timed out on chain", async () => {
  const reg = registryStub({ status: 1, deadlineSec: past });
  const r = await enforceDeadline({}, reg, { taskId: "0x1" });
  assert.equal(r.action, "timed-out");
  assert.deepEqual(reg.sent, ["0x1"]);
});

test("a task that settled since the index was built is left alone", async () => {
  // The index can be minutes stale; paying gas to be told it already settled is avoidable.
  const reg = registryStub({ status: 4, deadlineSec: past });
  const r = await enforceDeadline({}, reg, { taskId: "0x1" });
  assert.equal(r.action, "skipped");
  assert.deepEqual(reg.sent, []);
});

test("the on-chain deadline is authoritative over the index's", async () => {
  const reg = registryStub({ status: 1, deadlineSec: future });
  const r = await enforceDeadline({}, reg, { taskId: "0x1" });
  assert.equal(r.action, "skipped");
  assert.deepEqual(reg.sent, []);
});

test("a benign revert is a no-op, not an error", async () => {
  // Enforcement is permissionless, so anyone may have got there first.
  for (const msg of ["execution reverted: Not in progress", "execution reverted: Before deadline"]) {
    const r = await enforceDeadline({}, registryStub({ status: 1, deadlineSec: past, revert: msg }), { taskId: "0x1" });
    assert.equal(r.action, "skipped", msg);
  }
});

test("a real failure is reported rather than swallowed", async () => {
  const r = await enforceDeadline({}, registryStub({ status: 1, deadlineSec: past, revert: "insufficient funds" }), { taskId: "0x1" });
  assert.equal(r.action, "failed");
  assert.match(r.reason, /insufficient funds/);
});

test("enforcement is idempotent across two ticks", async () => {
  const sent = [];
  let status = 1;
  const reg = {
    sent,
    tasks: async () => ({ status, deadline: BigInt(past) }),
    slashOnTimeout: async (taskId) => { sent.push(taskId); status = 5; return { hash: "0xtx", wait: async () => ({}) }; },
  };
  assert.equal((await enforceDeadline({}, reg, { taskId: "0x1" })).action, "timed-out");
  assert.equal((await enforceDeadline({}, reg, { taskId: "0x1" })).action, "skipped");
  assert.deepEqual(sent, ["0x1"], "sent exactly once");
});
