import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsForTask, bidWindow, deadlineLabel, fmtCompact, fmtUSDC, isDone, isFinished, isOverdue, shortAddr } from "../utils.ts";
import { apiBase } from "../networks/apiBase.ts";
import { agentIdFrom } from "../tx.ts";

/**
 * Frontend logic, which had no tests at all.
 *
 * The UI is the largest surface in this project and every regression in it was caught by
 * hand: a formatter that reported real settled value as "0", a status badge that called an
 * overdue task "In progress", an env override that would have pointed every network at one
 * runtime. Each of those is pure logic, so each is testable without a DOM. Run with Node's
 * own type stripping, so this costs no new dependency.
 *
 * Component rendering is still untested; see the audit note.
 *
 * Imports carry explicit .ts extensions because Node's ESM resolver requires them. Vite does
 * not, which is why the app's own imports are extensionless.
 */

/* ── Money formatting ─────────────────────────────────────────────────────────
 * `fmtCompact` was built for USDC magnitudes and rounds to one decimal, so every
 * amount under 0.05 collapsed to "0". On an 18-decimal coin that turned genuinely
 * settled value into "nothing has settled" on the mainnet dashboard.
 */
test("a small but real amount is never shown as zero", () => {
  assert.equal(fmtCompact(0.02176), "0.0218"); // the exact figure that showed as 0
  assert.equal(fmtCompact(0.0085), "0.0085");
  assert.notEqual(fmtCompact(0.001), "0");
});

test("zero is still zero, and large numbers stay compact", () => {
  assert.equal(fmtCompact(0), "0");
  assert.equal(fmtCompact(918.36), "918.4");
  assert.equal(fmtCompact(1234), "1.2K");
  assert.equal(fmtCompact(1_500_000), "1.5M");
});

test("fmtUSDC survives null and undefined rather than rendering NaN", () => {
  for (const v of [null, undefined, ""] as const) {
    assert.doesNotThrow(() => fmtUSDC(v as never));
    assert.ok(!String(fmtUSDC(v as never)).includes("NaN"));
  }
});

/* ── Task state ───────────────────────────────────────────────────────────────
 * An ASSIGNED task past its deadline is overdue, not "in progress". Calling it the
 * latter is what made a stalled task look healthy.
 */
const HOUR = 3600_000;

test("a task past its deadline is overdue", () => {
  assert.equal(isOverdue({ status: "ASSIGNED", deadlineMs: Date.now() - HOUR }), true);
  assert.equal(isOverdue({ status: "OPEN", deadlineMs: Date.now() - HOUR }), true);
});

test("a task with time left is not overdue", () => {
  assert.equal(isOverdue({ status: "ASSIGNED", deadlineMs: Date.now() + HOUR }), false);
});

test("a terminal task is never overdue, however old", () => {
  // A settled task from last month must not be flagged; it is finished, not late.
  assert.equal(isOverdue({ status: "SETTLED", deadlineMs: Date.now() - 30 * 24 * HOUR }), false);
  assert.equal(isOverdue({ status: "CANCELLED", deadlineMs: Date.now() - 30 * 24 * HOUR }), false);
  // A passing attestation finishes a task even while the registry still says ASSIGNED.
  assert.equal(
    isOverdue({ status: "ASSIGNED", deadlineMs: Date.now() - HOUR, attestation: { passed: true } }),
    false,
  );
});

test("isDone and isFinished agree about a failing attestation", () => {
  // A FAILING attestation on an ASSIGNED task means the agent may retry, so neither
  // helper may call it finished — otherwise the UI hides a live deadline.
  const failing = { status: "ASSIGNED", attestation: { passed: false } };
  assert.equal(isDone(failing), false);
  assert.equal(isFinished(failing), false);
});

test("deadlineLabel says 'overdue' rather than a negative countdown", () => {
  assert.equal(deadlineLabel(Date.now() - HOUR, { status: "ASSIGNED" }), "overdue");
  assert.equal(deadlineLabel(Date.now() - HOUR, { status: "SETTLED" }), null);
});

/* ── The auction window the UI advertises ─────────────────────────────────── */

test("the bid window closes 20 minutes after creation", () => {
  const created = Date.now() - 5 * 60_000;
  const w = bidWindow(created, created + 6 * HOUR);
  assert.ok(w.closesInMs > 0 && w.closesInMs <= 15 * 60_000);
  assert.match(w.label, /bidding/);
});

test("a task due sooner than the window clamps to its deadline", () => {
  // Otherwise a 5-minute task would advertise 20 minutes of bidding it does not have.
  const created = Date.now();
  const w = bidWindow(created, created + 5 * 60_000);
  assert.ok(w.closesInMs <= 5 * 60_000);
});

test("a closed window reports closed, not a negative remainder", () => {
  const created = Date.now() - 2 * HOUR;
  assert.deepEqual(bidWindow(created, created + 6 * HOUR), { closesInMs: 0, label: "bidding closed" });
});

/* ── API base resolution ──────────────────────────────────────────────────────
 * VITE_API_URL is a single global override that beats every network's own default.
 * A local .env once leaked one into a production build; it was harmless only because
 * the per-network variable takes precedence. That precedence is the safeguard.
 */
test("a per-network API base wins over the global override", () => {
  const stub = { VITE_API_URL_BOTCHAIN_TESTNET: "https://bot.example", VITE_API_URL: "https://arc.example" };
  const resolve = (key: string, deployed: string) =>
    (stub as Record<string, string>)[`VITE_API_URL_${key}`] || stub.VITE_API_URL || deployed;
  assert.equal(resolve("BOTCHAIN_TESTNET", "https://fallback"), "https://bot.example");
});

test("apiBase falls back to the deployed default when nothing is configured", () => {
  assert.equal(apiBase("NO_SUCH_NETWORK_KEY", "https://deployed.example"), "https://deployed.example");
});

/* ── Identity derivation ──────────────────────────────────────────────────── */

test("agentId is deterministic and case-insensitive in both inputs", () => {
  const a = agentIdFrom("Nova-Prime", "0xCac2a31f431Bb9274bE9430a651b9c6a5d552174");
  const b = agentIdFrom("nova-prime", "0xcac2a31f431bb9274be9430a651b9c6a5d552174");
  assert.equal(a, b, "the on-chain id must not depend on how the name was typed");
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("agentId differs per wallet, so two agents cannot collide on a name", () => {
  const a = agentIdFrom("Agent", "0x1111111111111111111111111111111111111111");
  const b = agentIdFrom("Agent", "0x2222222222222222222222222222222222222222");
  assert.notEqual(a, b);
});

test("shortAddr keeps both ends so an address stays identifiable", () => {
  const addr = "0xCac2a31f431Bb9274bE9430a651b9c6a5d552174";
  const s = shortAddr(addr);
  assert.ok(s.startsWith("0xCac2"), s);
  assert.ok(s.endsWith("2174"), s);
});

/* ── Who can actually take this task? ─────────────────────────────────────────── */

const agent = (name: string, capabilities: string[], reputation = 100, online = true) => ({
  name,
  capabilities,
  reputation,
  online,
});

/**
 * The Create form used to happily escrow a budget on a task no agent would ever
 * read. This mirrors `capabilityMatch` in server/agent.js — if the two disagree,
 * the form promises bids that never arrive, which is worse than saying nothing.
 */
test("a task type nobody specialises in is open to every agent", () => {
  // The BOT testnet swarm as it was when a task of type `testing` drew zero bids.
  const swarm = [
    agent("Bohr-Research", ["research", "analysis", "summarization"]),
    agent("Bohr-Writer", ["writing", "code", "general"]),
  ];

  assert.deepEqual(
    agentsForTask(swarm, "testing", 100).map((a) => a.name),
    ["Bohr-Research", "Bohr-Writer"],
    "nobody claims 'testing', so it is an open call rather than an invisible task",
  );

  // A category with a specialist routes to that specialist — plus anyone flying the
  // "general" flag, which is a wildcard by design and predates this change.
  assert.deepEqual(agentsForTask(swarm, "analysis", 100).map((a) => a.name), ["Bohr-Research", "Bohr-Writer"]);

  // Without a "general" wildcard in the swarm, a claimed category really does
  // narrow to its specialist — which is what stops this becoming "everyone bids
  // on everything".
  const specialists = [agent("Researcher", ["research"]), agent("Designer", ["logo", "graphics"])];
  assert.deepEqual(agentsForTask(specialists, "logo", 100).map((a) => a.name), ["Designer"]);
  assert.deepEqual(agentsForTask(specialists, "research", 100).map((a) => a.name), ["Researcher"]);
  assert.deepEqual(
    agentsForTask(specialists, "video-editing", 100).map((a) => a.name),
    ["Researcher", "Designer"],
    "but an unclaimed category is still open to all of them",
  );
});

test("the reputation floor excludes agents just as completely as a bad capability", () => {
  // Bohr-Writer was slashed to 50 on chain while the UI still showed 100, so a
  // requester setting the default floor of 100 saw an agent that could never bid.
  const swarm = [
    agent("Bohr-Research", ["research"], 145),
    agent("Bohr-Writer", ["writing", "general"], 50),
  ];

  assert.deepEqual(agentsForTask(swarm, "research", 100).map((a) => a.name), ["Bohr-Research"]);
  assert.deepEqual(
    agentsForTask(swarm, "research", 50).map((a) => a.name),
    ["Bohr-Research", "Bohr-Writer"],
    "lowering the floor brings the slashed agent back into range",
  );
});

test("offline agents and empty types never count as coverage", () => {
  const swarm = [agent("Sleeping", ["research"], 100, false), agent("Awake", ["research"], 100)];
  assert.deepEqual(agentsForTask(swarm, "research", 0).map((a) => a.name), ["Awake"]);
  assert.deepEqual(agentsForTask(swarm, "", 0), [], "an unnamed custom type is not an open call");
  assert.deepEqual(agentsForTask(swarm, "   ", 0), []);
});

test("an agent with no declared capabilities is a generalist", () => {
  const swarm = [agent("Jack", []), agent("Specialist", ["logo"])];
  assert.deepEqual(agentsForTask(swarm, "logo", 0).map((a) => a.name), ["Jack", "Specialist"]);
});
