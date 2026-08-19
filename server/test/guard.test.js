import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { authorizeVerify, isInternal, rateLimit } from "../guard.js";

/**
 * `/api/verify` was open to the internet: anyone with a task id could make the
 * runtime spend model credits and gas. These tests pin the access rules, because the
 * failure mode of getting them wrong is a bill rather than an error.
 */

const SECRET = "s3cret-value-for-tests";
const taskId = "0x" + "ab".repeat(32);

/** Minimal stand-ins for an express request and the chain context. */
function req({ headers = {}, body = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (h) => lower[String(h).toLowerCase()], body, ip: "1.2.3.4", socket: {} };
}
// verifyAgentSignature falls back to an ERC-1271 call for contract wallets; a
// provider that always throws makes that path fail cleanly, which is what we want
// for plain EOA signature checks.
const ctx = { provider: { call: async () => { throw new Error("no contract"); } } };

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = SECRET;
});

test("the internal secret authorises, and a wrong one does not", async () => {
  assert.equal(isInternal(req({ headers: { "x-polaris-internal": SECRET } })), true);
  assert.equal(isInternal(req({ headers: { "x-polaris-internal": "wrong" } })), false);
  assert.equal(isInternal(req()), false);
});

test("no secret configured means nobody is treated as internal", () => {
  delete process.env.INTERNAL_API_SECRET;
  assert.equal(
    isInternal(req({ headers: { "x-polaris-internal": SECRET } })),
    false,
    "an unset secret must not turn every caller into an internal one",
  );
});

test("an anonymous request is refused with 401", async () => {
  const out = await authorizeVerify(req(), ctx, { taskId, agent: ethers.Wallet.createRandom().address, requester: ethers.Wallet.createRandom().address });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.match(out.error, /authoris/i);
});

test("the runtime's own call is authorised by the header alone", async () => {
  const out = await authorizeVerify(req({ headers: { "x-polaris-internal": SECRET } }), ctx, {
    taskId,
    agent: ethers.Wallet.createRandom().address,
    requester: ethers.Wallet.createRandom().address,
  });
  assert.equal(out.ok, true);
  assert.equal(out.via, "internal");
});

test("the assigned agent can authorise with a signature", async () => {
  const agent = ethers.Wallet.createRandom();
  const signature = await agent.signMessage(`polaris-verify:${taskId.toLowerCase()}`);
  const out = await authorizeVerify(req({ body: { signature } }), ctx, {
    taskId,
    agent: agent.address,
    requester: ethers.Wallet.createRandom().address,
  });
  assert.equal(out.ok, true);
  assert.equal(out.via, "agent");
});

test("the requester can authorise too, since they are paying", async () => {
  const requester = ethers.Wallet.createRandom();
  const signature = await requester.signMessage(`polaris-verify:${taskId.toLowerCase()}`);
  const out = await authorizeVerify(req({ body: { signature } }), ctx, {
    taskId,
    agent: ethers.Wallet.createRandom().address,
    requester: requester.address,
  });
  assert.equal(out.ok, true);
  assert.equal(out.via, "requester");
});

test("a signature from an unrelated wallet is refused", async () => {
  const stranger = ethers.Wallet.createRandom();
  const signature = await stranger.signMessage(`polaris-verify:${taskId.toLowerCase()}`);
  const out = await authorizeVerify(req({ body: { signature } }), ctx, {
    taskId,
    agent: ethers.Wallet.createRandom().address,
    requester: ethers.Wallet.createRandom().address,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
});

test("a signature for a DIFFERENT task does not authorise this one", async () => {
  const agent = ethers.Wallet.createRandom();
  const signature = await agent.signMessage(`polaris-verify:${"0x" + "cd".repeat(32)}`);
  const out = await authorizeVerify(req({ body: { signature } }), ctx, {
    taskId,
    agent: agent.address,
    requester: ethers.Wallet.createRandom().address,
  });
  assert.equal(out.ok, false, "otherwise one signature would unlock every task");
});

test("the rate limiter allows up to the cap, then answers 429 with Retry-After", () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 3, name: "verification" });
  const r = req();
  let allowed = 0;
  let status = 0;
  const headers = {};
  const res = {
    status(c) {
      status = c;
      return this;
    },
    json() {
      return this;
    },
    set(k, v) {
      headers[k] = v;
    },
  };
  for (let i = 0; i < 5; i++) limiter(r, res, () => allowed++);
  assert.equal(allowed, 3);
  assert.equal(status, 429);
  assert.ok(headers["Retry-After"], "a client needs to know when to come back");
});

test("internal callers are exempt from the rate limit", () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  const r = req({ headers: { "x-polaris-internal": SECRET } });
  let allowed = 0;
  const res = { status: () => res, json: () => res, set: () => {} };
  for (let i = 0; i < 10; i++) limiter(r, res, () => allowed++);
  assert.equal(allowed, 10, "throttling the swarm would stall settlement");
});
