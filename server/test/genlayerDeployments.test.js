import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * `genlayer/deployments.json` is the record a hackathon steward reads to reproduce a
 * decision: addresses, transaction hashes, and the decision ids that bind a GenLayer
 * verdict to its Arc/BOT mirror receipts. Those values are transcribed by hand and are
 * never resolved by any code path, so a truncated one fails nowhere — it just hands an
 * auditor a string that every tool rejects with "invalid BytesLike value".
 *
 * That already happened: `studionetEndToEndTest.decisionId` shipped with 63 hex
 * characters, one short, and the only way to recover the real id was to read it back
 * off the BOT relay transaction's calldata. These tests pin the shape so the next
 * transcription slip fails here instead of in front of a judge.
 */

const record = JSON.parse(fs.readFileSync(new URL("../../genlayer/deployments.json", import.meta.url), "utf8"));

/** Every `0x…` string in the record, with a dotted path so a failure names the culprit. */
function hexValues(node, path = "") {
  if (typeof node === "string") return node.startsWith("0x") ? [[path, node]] : [];
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => hexValues(value, path ? `${path}.${key}` : key));
}

test("every hash and decision id is a full 32-byte value", () => {
  const found = hexValues(record).filter(([path]) => !/\b(adjudicator|verdictMirror)$/.test(path));
  assert.ok(found.length > 0, "no hex values found — has the record moved?");
  for (const [path, value] of found) {
    assert.match(value, /^0x[0-9a-f]{64}$/, `${path} is not a 32-byte lowercase hex value: ${value} (${value.length - 2} hex chars)`);
  }
});

test("every contract address is a full 20-byte value", () => {
  const found = hexValues(record).filter(([path]) => /\b(adjudicator|verdictMirror)$/.test(path));
  assert.ok(found.length > 0, "no addresses found — has the record moved?");
  for (const [path, value] of found) {
    assert.match(value, /^0x[0-9a-fA-F]{40}$/, `${path} is not a 20-byte address: ${value}`);
  }
});

test("the end-to-end decision id is the one the BOT mirror actually recorded", () => {
  // Read from BOT relay tx 0x95003f13c3df0a1cb87131b58c86339078c7bcefc18c472d0a468440d1655083
  // (block 23153403) — its first calldata argument and its VerdictRecorded topic.
  assert.equal(
    record.studionetEndToEndTest.decisionId,
    "0xee9ac66dfeb06d2850814634c067bb95eba2cfdfa0ba5f2de12cdcf6f04a910f",
  );
});
