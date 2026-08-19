import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * A rate limit must pause the scan, not abandon it.
 *
 * Arc's production index sat at 4 tasks against ~270 on chain because
 * `queryOneChunk` treated the very first `-32005 rate limit exceeded` as fatal: it
 * threw without waiting, `scanRange` stops (never skips) on any failure so the
 * checkpoint could not advance, and the next tick hit the limiter at the same block.
 * The index could never warm up on a shared public endpoint.
 *
 * These tests pin the behaviour that fixes it: a transient limit is retried with
 * backoff and the chunk still returns its logs, while a limiter that never relents is
 * reported as `rateLimited` so the caller keeps its checkpoint and tries again later.
 * The backoff ladder is shrunk through the env var so the suite does not sleep.
 */

process.env.INDEX_RATE_LIMIT_BACKOFF_MS = "1,1,1,1";
const { queryOneChunk, rateLimitBackoffMs } = await import("../chain.js");

/** An RPC that refuses `refusals` times with a JSON-RPC rate-limit error, then answers. */
function flakyContract(refusals, logs = [{ blockNumber: 1 }]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async queryFilter() {
      calls += 1;
      if (calls <= refusals) {
        const e = new Error("could not coalesce error");
        e.error = { code: -32005, message: "rate limit exceeded" };
        throw e;
      }
      return logs;
    },
  };
}

test("a chunk that is rate limited once still returns its logs", async () => {
  const c = flakyContract(1);
  const out = await queryOneChunk(c, "*", 100, 200);
  assert.deepEqual(out, [{ blockNumber: 1 }]);
  assert.equal(c.calls, 2, "should retry after backing off, not give up");
});

test("a chunk survives the whole backoff ladder", async () => {
  const c = flakyContract(4);
  const out = await queryOneChunk(c, "*", 100, 200);
  assert.deepEqual(out, [{ blockNumber: 1 }]);
  assert.equal(c.calls, 5);
});

test("a limiter that never relents is reported as rateLimited, not as a generic failure", async () => {
  const c = flakyContract(Infinity);
  await assert.rejects(
    () => queryOneChunk(c, "*", 100, 200),
    (e) => {
      assert.equal(e.rateLimited, true, "caller relies on this flag to keep its checkpoint");
      return true;
    },
  );
  // One attempt per ladder rung, plus the final one that reports the failure.
  assert.equal(c.calls, rateLimitBackoffMs().length + 1);
});

test("a non-rate-limit error is retried on the short ladder and then surfaced", async () => {
  let calls = 0;
  const c = {
    async queryFilter() {
      calls += 1;
      throw new Error("boom");
    },
  };
  await assert.rejects(() => queryOneChunk(c, "*", 1, 2), /boom/);
  assert.ok(calls > 1, "a transient network error should be retried");
});

test("the backoff ladder falls back to the default when the env var is unusable", () => {
  const saved = process.env.INDEX_RATE_LIMIT_BACKOFF_MS;
  process.env.INDEX_RATE_LIMIT_BACKOFF_MS = "nonsense,,";
  assert.deepEqual(rateLimitBackoffMs(), [1000, 2500, 6000, 12000]);
  process.env.INDEX_RATE_LIMIT_BACKOFF_MS = saved;
});
