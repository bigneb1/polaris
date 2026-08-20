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

/** Default the cutoff off, so the existing selection tests read as before. */
const ANY = { enforceFromMs: 0 };

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
  assert.deepEqual(overdueCandidates({ tasks }, { now, ...ANY }).map((t) => t.taskId), ["0x1", "0x2"]);
});

test("the grace period keeps us from fighting block-timestamp skew", () => {
  const now = Date.now();
  // Just barely past our clock: `slashOnTimeout` requires block.timestamp > deadline
  // strictly, so acting immediately would only earn a "Before deadline" revert.
  const tasks = [{ taskId: "0x1", status: "ASSIGNED", deadlineMs: now - 1000 }];
  assert.equal(overdueCandidates({ tasks }, { now, graceMs: 60000, ...ANY }).length, 0);
  assert.equal(overdueCandidates({ tasks }, { now, graceMs: 0, ...ANY }).length, 1);
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

test("a pre-existing backlog is grandfathered, not retroactively punished", () => {
  // Enforcement was missing for the deployment's whole life, so switching it on found 114
  // overdue tasks on Arc. Clearing them would have slashed four agents 114 times between
  // them and taken three to reputation 0, below the bid floor, for failures caused by the
  // missing reaper itself. Only deadlines that pass after enforcement starts are eligible.
  const now = Date.now();
  const enforceFromMs = now - 1 * HOUR; // reaper started an hour ago
  const tasks = [
    { taskId: "0xold", status: "ASSIGNED", deadlineMs: now - 40 * 24 * HOUR }, // 40 days stale
    { taskId: "0xnew", status: "ASSIGNED", deadlineMs: now - 30 * 60_000 }, // expired since
  ];
  assert.deepEqual(
    overdueCandidates({ tasks }, { now, enforceFromMs }).map((t) => t.taskId),
    ["0xnew"],
  );
});

test("the backlog can be enforced deliberately, with the cutoff turned off", () => {
  const now = Date.now();
  const tasks = [{ taskId: "0xold", status: "ASSIGNED", deadlineMs: now - 40 * 24 * HOUR }];
  assert.equal(overdueCandidates({ tasks }, { now, enforceFromMs: 0 }).length, 1);
});

/* ── 4. The auction must actually be an auction ───────────────────────────────── */

/**
 * Bidding used to close the auction in the same breath as placing the bid, which made the
 * market first-poll-wins: the first agent to notice a task bid AND awarded it, every other
 * agent hit BidEngine's `auctionClosed` guard, and the on-chain scoring (price 40% /
 * reputation 40% / speed 20%) never had a second bid to compare. One bid per task, always.
 *
 * The window is now derived from on-chain data so every agent and every restart agrees, and
 * closing happens in the tick rather than on a `setTimeout` a restart would forget.
 */
const BID_WINDOW_MS = 20 * 60 * 1000;

/** The rule the swarm applies, kept in one place so the test pins the policy not the code. */
function auctionState({ createdAtMs, deadlineMs, now, windowMs = BID_WINDOW_MS }) {
  const w = Math.min(windowMs, Math.max(0, deadlineMs - createdAtMs));
  return now >= createdAtMs + w ? "award" : "bid";
}

test("an auction stays open for the whole bid window, so every agent can bid", () => {
  const created = Date.now();
  const deadline = created + 6 * HOUR;
  // Seconds in: still collecting bids, which is what the old code got wrong.
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: created + 5000 }), "bid");
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: created + 19 * 60_000 }), "bid");
});

test("once the window passes, the auction is awarded on score", () => {
  const created = Date.now();
  const deadline = created + 6 * HOUR;
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: created + BID_WINDOW_MS }), "award");
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: created + BID_WINDOW_MS + 1 }), "award");
});

test("a task due sooner than the window is awarded at its deadline, not after it", () => {
  // Clamping matters: a 5-minute task must not wait 20 minutes for its auction, or it would
  // expire unawarded and become exactly the stuck state the reaper has to clean up.
  const created = Date.now();
  const deadline = created + 5 * 60_000;
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: created + 60_000 }), "bid");
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: created + 5 * 60_000 }), "award");
});

test("the window is computed from creation, so a restart reaches the same verdict", () => {
  // The Circle swarm schedules the close with setTimeout, which a restart forgets, leaving a
  // task OPEN with bids and nothing to award it. Deriving it from on-chain createdAt/deadline
  // means any process, at any time, computes the same answer.
  const created = Date.now() - 25 * 60_000; // created 25 minutes ago, window long past
  const deadline = created + 6 * HOUR;
  assert.equal(auctionState({ createdAtMs: created, deadlineMs: deadline, now: Date.now() }), "award");
});

/**
 * Bid pricing has to respect the asset's precision.
 *
 * `toFixed(2)` and a hard 0.01 floor are USDC-isms. On BOT Chain a 0.01 budget with a 0.85
 * markup rounded straight back to 0.01, so four agents with four different markups all
 * submitted the identical bid and the price component of BidEngine's score (40% of it) could
 * not discriminate at all. Observed live on mainnet before this was fixed.
 */
function bidFor(budget, markup, decimals) {
  const dp = decimals >= 18 ? 6 : 2;
  return Math.max(10 ** -dp, +(budget * markup).toFixed(dp));
}

test("distinct markups produce distinct bids on an 18-decimal coin", () => {
  const bids = [0.85, 0.8, 0.88, 0.75].map((m) => bidFor(0.01, m, 18));
  assert.equal(new Set(bids).size, 4, `all four must differ, got ${bids.join(", ")}`);
  assert.deepEqual(bids, [0.0085, 0.008, 0.0088, 0.0075]);
});

test("a 6-decimal stablecoin keeps its two-decimal pricing", () => {
  assert.equal(bidFor(10, 0.85, 6), 8.5);
  assert.equal(bidFor(1, 0.85, 6), 0.85);
});

test("the floor scales with the asset instead of being a hardcoded cent", () => {
  // A hard 0.01 floor on an 18-decimal coin would raise a sub-cent bid ABOVE the budget.
  assert.equal(bidFor(0.000001, 0.85, 18), 0.000001);
  assert.ok(bidFor(0.000001, 0.85, 18) <= 0.000001, "a bid must never exceed a tiny budget");
});

/* ── 5. Staking must not starve the identity mint ─────────────────────────────── */

/**
 * Three of four mainnet agents registered with no ERC-8004 identity, and the one that got
 * one differed only in being funded slightly higher. `ensureRegistered` checked the balance
 * covered `stake + gas`, staked, and then minted out of what was left — a few thousandths of
 * a coin — so the mint died inside a best-effort catch. And because `ensureRegistered` runs
 * once at startup, nothing ever retried it.
 */
const ONE = 10n ** 18n;
const parse = (n) => BigInt(Math.round(n * 1e18));

/** The funding rule: what an agent must hold before it is allowed to stake. */
function requiredToStake({ stake, gasReserve, identityReserve, native = true, smartAccount = false }) {
  const reserveGas = native && !smartAccount;
  return (reserveGas ? stake + gasReserve : stake) + (reserveGas ? identityReserve : 0n);
}

test("an agent funded only for stake plus gas is refused, because the mint would fail", () => {
  const stake = parse(0.02), gas = parse(0.003), identity = parse(0.004);
  const needed = requiredToStake({ stake, gasReserve: gas, identityReserve: identity });
  // Exactly what the three mainnet agents held: enough to stake, nothing left to mint.
  assert.ok(parse(0.026) < needed, "0.026 must no longer pass the funding check");
  assert.equal(needed, parse(0.027));
});

test("an agent funded for stake, gas and the mint is allowed through", () => {
  const stake = parse(0.02), gas = parse(0.003), identity = parse(0.004);
  const needed = requiredToStake({ stake, gasReserve: gas, identityReserve: identity });
  // Polaris-Prime's funding, which is why it alone holds an identity.
  assert.ok(parse(0.05) >= needed);
});

test("a smart account reserves neither, because its gas comes from the EntryPoint deposit", () => {
  const stake = parse(0.02), gas = parse(0.003), identity = parse(0.004);
  const needed = requiredToStake({ stake, gasReserve: gas, identityReserve: identity, smartAccount: true });
  assert.equal(needed, stake, "reserving out of its balance would refuse a perfectly funded account");
});

test("an ERC-20 network reserves nothing extra: stake and gas are different assets", () => {
  const stake = 100n * ONE, gas = parse(0.003), identity = parse(0.004);
  assert.equal(requiredToStake({ stake, gasReserve: gas, identityReserve: identity, native: false }), stake);
});

/** Which agents a tick should attempt an identity mint for. */
function needsIdentity(agents) {
  return agents.filter((a) => !a.erc8004Id && a.hasGas).map((a) => a.name);
}

test("the tick retries the mint for a registered agent that has no identity", () => {
  const agents = [
    { name: "Polaris-Prime", erc8004Id: "0", hasGas: true }, // already has one
    { name: "Nova-Prime", erc8004Id: null, hasGas: true }, // failed at startup, now funded
    { name: "Vega-Prime", erc8004Id: null, hasGas: false }, // still gas-starved
  ];
  assert.deepEqual(needsIdentity(agents), ["Nova-Prime"]);
});

test("an agent that already holds an identity is never re-minted", () => {
  assert.deepEqual(needsIdentity([{ name: "A", erc8004Id: "7", hasGas: true }]), []);
});

/* ── 6. Never work a task that is no longer live ──────────────────────────────── */

/**
 * `fulfilWins` replays `BidAwarded` logs from the index's start block, so a task won long ago
 * reappears on every boot. It did not check the task's current status first.
 *
 * Seen on mainnet: an agent ran out of gas, its task's deadline passed, the reaper cancelled
 * it and refunded the requester. Hours later the agent was funded, came back, replayed the old
 * award, paid for a fresh deliverable, and failed on chain with the escrow's "Already
 * resolved" — burning its whole retry budget on a task that had been dead since the night
 * before.
 */
const TASK = { OPEN: 0, ASSIGNED: 1, IN_PROGRESS: 2, COMPLETED: 3, SETTLED: 4, CANCELLED: 5 };

/** The guard: work it only if it is still assigned, and still assigned to us. */
function shouldFulfil(onChain, me) {
  const live = onChain.status === TASK.ASSIGNED || onChain.status === TASK.IN_PROGRESS;
  return live && onChain.assignedAgent.toLowerCase() === me.toLowerCase();
}

const ME = "0xCac2a31f431Bb9274bE9430a651b9c6a5d552174";

test("a task the reaper already cancelled is skipped, not re-worked", () => {
  assert.equal(shouldFulfil({ status: TASK.CANCELLED, assignedAgent: ME }, ME), false);
});

test("a task that already settled is skipped", () => {
  assert.equal(shouldFulfil({ status: TASK.SETTLED, assignedAgent: ME }, ME), false);
});

test("a task reopened and awarded to someone else is skipped", () => {
  const other = "0xf83e5eafEE455C688B959915E3AFBE28c468571c";
  assert.equal(shouldFulfil({ status: TASK.ASSIGNED, assignedAgent: other }, ME), false);
});

test("a live task still assigned to us is worked", () => {
  assert.equal(shouldFulfil({ status: TASK.ASSIGNED, assignedAgent: ME }, ME), true);
  assert.equal(shouldFulfil({ status: TASK.IN_PROGRESS, assignedAgent: ME.toLowerCase() }, ME), true);
});
