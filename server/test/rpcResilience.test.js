import { test } from "node:test";
import assert from "node:assert/strict";

import { isTransientRpcError, withRpcRetry } from "../rpcRetry.js";
import { biddingIsOpen, capabilityMatch } from "../agent.js";

/**
 * A funded task on BOT testnet sat OPEN with zero bids for ten hours.
 *
 * Four independent defects had to line up for that, and each one is pinned here.
 * The chain of causation was: the only RPC endpoint started returning intermittent
 * nginx 503s → nothing retried them → each one aborted the ENTIRE swarm tick → the
 * task's 20-minute auction window elapsed with no bid placed → and once a window
 * closes with no bids, the old code could never bid on that task again.
 */

/* ── 1. Transient failures are retried; refusals are not ──────────────────────── */

const err = (props) => Object.assign(new Error(props.message ?? "boom"), props);

test("a 503 is transient, a revert is not", () => {
  // Exactly the shape ethers produced during the outage.
  assert.equal(isTransientRpcError(err({ code: "SERVER_ERROR", info: { responseStatus: "503 Service Temporarily Unavailable" } })), true);
  assert.equal(isTransientRpcError(err({ code: "SERVER_ERROR", info: { responseStatus: "429 Too Many Requests" } })), true);
  assert.equal(isTransientRpcError(err({ code: "TIMEOUT" })), true);
  assert.equal(isTransientRpcError(err({ code: "NETWORK_ERROR" })), true);
  assert.equal(isTransientRpcError(err({ message: "socket hang up" })), true);

  // A revert has an answer from the chain. Repeating it just reverts again, and
  // retrying it three times would report a legitimate failure 800ms late.
  assert.equal(isTransientRpcError(err({ code: "CALL_EXCEPTION", reason: "No bids" })), false);
  assert.equal(isTransientRpcError(err({ code: "INSUFFICIENT_FUNDS" })), false);
  assert.equal(isTransientRpcError(err({ code: "NONCE_EXPIRED" })), false);
  assert.equal(isTransientRpcError(err({ code: "BAD_DATA" })), false);
  // A 4xx that isn't 429 is us being wrong, not the server being sick.
  assert.equal(isTransientRpcError(err({ code: "SERVER_ERROR", info: { responseStatus: "400 Bad Request" } })), false);
  assert.equal(isTransientRpcError(null), false);
});

test("a flapping endpoint is retried with backoff and then succeeds", async () => {
  let calls = 0;
  const slept = [];
  const provider = {
    send: async () => {
      calls++;
      if (calls < 3) throw err({ code: "SERVER_ERROR", info: { responseStatus: "503" } });
      return "0x3c8";
    },
  };
  withRpcRetry(provider, { attempts: 3, baseDelayMs: 200, sleep: async (ms) => slept.push(ms) });

  assert.equal(await provider.send("eth_chainId", []), "0x3c8");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [200, 600]); // exponential, and bounded
});

test("retries are bounded — a permanently sick endpoint still fails", async () => {
  let calls = 0;
  const provider = {
    send: async () => {
      calls++;
      throw err({ code: "SERVER_ERROR", info: { responseStatus: "503" } });
    },
  };
  withRpcRetry(provider, { attempts: 3, baseDelayMs: 0, sleep: async () => {} });

  await assert.rejects(() => provider.send("eth_call", []));
  assert.equal(calls, 3, "gives up rather than retrying forever");
});

test("a revert is not retried at all", async () => {
  let calls = 0;
  const provider = {
    send: async () => {
      calls++;
      throw err({ code: "CALL_EXCEPTION", reason: "Auction closed" });
    },
  };
  withRpcRetry(provider, { attempts: 3, baseDelayMs: 0, sleep: async () => {} });

  await assert.rejects(() => provider.send("eth_call", []));
  assert.equal(calls, 1, "a refusal must fail fast");
});

test("a signed transaction is never replayed", async () => {
  let calls = 0;
  const provider = {
    send: async () => {
      calls++;
      throw err({ code: "SERVER_ERROR", info: { responseStatus: "503" } });
    },
  };
  withRpcRetry(provider, { attempts: 3, baseDelayMs: 0, sleep: async () => {} });

  // It may already be in the mempool; a blind re-send surfaces as "already known"
  // or a nonce error and masks the real failure. Callers retry sends themselves.
  await assert.rejects(() => provider.send("eth_sendRawTransaction", ["0xdead"]));
  assert.equal(calls, 1);
});

/* ── 2. A window that closed with no bids does not end the task ───────────────── */

test("bidding stays open while a task has no bids at all", () => {
  // Normal auction: open during the window, shut after it.
  assert.equal(biddingIsOpen(false, 0n), true);
  assert.equal(biddingIsOpen(false, 3n), true);
  assert.equal(biddingIsOpen(true, 3n), false, "late bids into a live auction would be sniping");

  // The stuck case. Zero bids means there is no auction to protect, so the call
  // stays open rather than the task becoming permanently unassignable.
  assert.equal(biddingIsOpen(true, 0n), true);
  assert.equal(biddingIsOpen(true, 0), true, "a plain number counts the same as a bigint");
});

/* ── 3. A task type nobody claims is an open call, not an invisible task ──────── */

test("a custom task type nobody specialises in is open to everyone", () => {
  // The swarm that was live when the task got stuck.
  const specialised = new Set(["research", "analysis", "summarization", "writing", "code"]);

  // `testing` — what the requester typed into the "other" box — matched nobody, so
  // the task was invisible to the entire swarm.
  assert.equal(capabilityMatch(["research", "analysis", "summarization"], "testing", specialised), true);
  assert.equal(capabilityMatch(["writing", "code"], "testing", specialised), true);

  // A category with a specialist still routes to the specialist, so this does not
  // just turn every agent into a generalist.
  assert.equal(capabilityMatch(["writing", "code"], "research", specialised), false);
  assert.equal(capabilityMatch(["research"], "research", specialised), true);

  // The two existing escape hatches keep working.
  assert.equal(capabilityMatch(["writing", "general"], "research", specialised), true, "'general' bids on anything");
  assert.equal(capabilityMatch([], "research", specialised), true, "no declared capabilities means generalist");
  assert.equal(capabilityMatch(undefined, "research", specialised), true);
});
