import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Classifying a failed identity mint.
 *
 * The first version of this matched the error NAME in the revert message, and it never
 * fired: a node returns raw revert data, and ethers only names a custom error when the ABI
 * declares it, so every failure was filed as a generic "rejected". On BOT Chain that meant
 * three agents that provably cannot hold an ERC-721 were indistinguishable from an agent
 * that simply had not minted yet, which is the exact ambiguity this whole feature exists to
 * remove.
 *
 * So the classification keys on the four-byte selector, which does not depend on what the
 * client happens to know. These tests pin that, and pin the caching, since an uncached
 * probe would put the dashboard back on the rate-limited RPC.
 */

const SELECTOR = "0x64a0ae92"; // ERC721InvalidReceiver(address)

process.env.POLARIS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-mintable-"));
const { identityMintability } = await import("../erc8004.js");

/** A chain context whose registry reverts however the test asks it to. */
function ctxThatReverts(err, { calls } = { calls: [] }) {
  return {
    id: "botchain-testnet",
    chainId: 968,
    ADDR: { erc8004Identity: "0x000000000000000000000000000000000000dEaD" },
    provider: {
      // ethers builds the contract from this; only `call` is exercised by staticCall.
      call: async () => {
        calls.push(1);
        if (err) throw err;
        // A uint256 return value, ABI-encoded.
        return `0x${"".padStart(64, "0").slice(0, 63)}8`;
      },
      getNetwork: async () => ({ chainId: 968n, name: "bot" }),
      _detectNetwork: async () => ({ chainId: 968n, name: "bot" }),
      resolveName: async (n) => n,
    },
  };
}

function revert(data, message = "execution reverted (unknown custom error)") {
  const e = new Error(message);
  e.data = data;
  e.shortMessage = message;
  return e;
}

test("an ERC721InvalidReceiver revert is identified by selector, not by its message", async () => {
  const ctx = ctxThatReverts(revert(`${SELECTOR}${"0".repeat(64)}`));
  assert.equal(await identityMintability(ctx, "0x1111111111111111111111111111111111111111"), "unsupported-receiver");
});

test("the selector is found when the node nests it under info.error.data", async () => {
  const e = new Error("execution reverted");
  e.info = { error: { data: `${SELECTOR}${"0".repeat(64)}` } };
  const ctx = ctxThatReverts(e);
  assert.equal(await identityMintability(ctx, "0x2222222222222222222222222222222222222222"), "unsupported-receiver");
});

test("a client that does name the error is still understood", async () => {
  const ctx = ctxThatReverts(revert(undefined, 'reverted with custom error ERC721InvalidReceiver("0x…")'));
  assert.equal(await identityMintability(ctx, "0x3333333333333333333333333333333333333333"), "unsupported-receiver");
});

test("any other revert is 'rejected', never mistaken for an unmintable address", async () => {
  const ctx = ctxThatReverts(revert("0xdeadbeef", "execution reverted: Already registered"));
  assert.equal(await identityMintability(ctx, "0x4444444444444444444444444444444444444444"), "rejected");
});

test("a network without a registry is never probed", async () => {
  const calls = [];
  const ctx = ctxThatReverts(null, { calls });
  ctx.ADDR.erc8004Identity = null;
  assert.equal(await identityMintability(ctx, "0x5555555555555555555555555555555555555555"), "rejected");
  assert.equal(calls.length, 0, "no registry means no call to make");
});

test("a verdict is cached, so the same address is probed at most once", async () => {
  const calls = [];
  const wallet = "0x6666666666666666666666666666666666666666";
  const first = ctxThatReverts(revert(`${SELECTOR}${"0".repeat(64)}`), { calls });
  assert.equal(await identityMintability(first, wallet), "unsupported-receiver");
  const before = calls.length;
  assert.ok(before > 0, "the first probe must actually hit the chain");

  // A context that would throw something different proves the answer came from the cache
  // rather than from a second call.
  const second = ctxThatReverts(revert("0xdeadbeef", "different failure"), { calls });
  assert.equal(await identityMintability(second, wallet), "unsupported-receiver");
  assert.equal(calls.length, before, "a cached verdict must not re-probe");
});

test("concurrent probes all persist: no verdict is lost to a last-writer-wins race", async () => {
  // The overview probes every identity-less agent at once. The first version of the cache
  // read the whole file, added one key and wrote the file back, so four parallel probes
  // each persisted only their own result and three were silently dropped. Production
  // showed exactly that: one agent carried a verdict and three stayed unknown.
  const wallets = [
    "0xa000000000000000000000000000000000000001",
    "0xa000000000000000000000000000000000000002",
    "0xa000000000000000000000000000000000000003",
    "0xa000000000000000000000000000000000000004",
  ];
  const ctx = ctxThatReverts(revert(`${SELECTOR}${"0".repeat(64)}`));
  await Promise.all(wallets.map((w) => identityMintability(ctx, w)));

  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.POLARIS_STATE_DIR, "erc8004-mintable-968.json"), "utf8"));
  for (const w of wallets) {
    assert.equal(onDisk[w], "unsupported-receiver", `${w} must survive the concurrent write`);
  }
});
