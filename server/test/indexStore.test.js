import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openIndexStore } from "../indexStore.js";

/**
 * The index store is the cache that stops the runtime re-scanning a chain on every
 * boot, so the properties worth pinning are the ones that made the old JSON version
 * fragile: writes must be transactional, a re-scanned chunk must not duplicate
 * events, checkpoints must not run ahead of the data they claim to cover, and an
 * existing JSON checkpoint must import without loss.
 */

function freshStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `polaris-idx-${name}-`));
  // A unique chain id per test keeps the module-level store cache from handing back
  // another test's database.
  const chainId = Math.floor(Math.random() * 1e9);
  process.env[`INDEX_DB_${chainId}`] = path.join(dir, "index.db");
  const db = openIndexStore(chainId);
  return { db, dir, chainId };
}

test("sqlite is available in this Node, so the store is real and not the JSON fallback", () => {
  const { db } = freshStore("avail");
  assert.ok(db, "node:sqlite unavailable — the runtime would silently fall back to JSON stores");
});

test("logs round-trip in (block, logIndex) order", () => {
  const { db } = freshStore("order");
  db.saveLogs(
    "tasks",
    [
      { name: "B", blockNumber: 10, li: 1, txHash: "0xb", args: {} },
      { name: "A", blockNumber: 10, li: 0, txHash: "0xa", args: {} },
      { name: "C", blockNumber: 11, li: 0, txHash: "0xc", args: {} },
    ],
    11,
  );
  assert.deepEqual(
    db.loadLogs("tasks").map((l) => l.name),
    ["A", "B", "C"],
  );
  assert.equal(db.lastBlock("tasks"), 11);
});

test("re-scanning a chunk does not duplicate events", () => {
  const { db } = freshStore("dedupe");
  const chunk = [
    { name: "TaskSubmitted", blockNumber: 5, li: 0, txHash: "0x1", args: {} },
    { name: "BidPlaced", blockNumber: 5, li: 1, txHash: "0x1", args: {} },
  ];
  db.saveLogs("tasks", chunk, 5);
  db.saveLogs("tasks", chunk, 5); // a crash between write and checkpoint replays it
  assert.equal(db.loadLogs("tasks").length, 2, "the JSON array version would now hold 4");
});

test("records collapse to the latest per id", () => {
  const { db } = freshStore("records");
  db.saveRecords("plans", [["0xabc", { status: "OPEN", blockNumber: 1 }]], 1);
  db.saveRecords("plans", [["0xabc", { status: "ACTIVE", blockNumber: 2 }]], 2);
  const all = db.loadRecords("plans");
  assert.equal(Object.keys(all).length, 1);
  assert.equal(all["0xabc"].status, "ACTIVE");
  assert.equal(db.lastBlock("plans"), 2);
});

test("stores are namespaced, so one contract's logs never leak into another's", () => {
  const { db } = freshStore("namespace");
  db.saveLogs("tasks", [{ name: "T", blockNumber: 1, li: 0, txHash: "0x1", args: {} }], 1);
  db.saveLogs("agents", [{ name: "A", blockNumber: 1, li: 0, txHash: "0x2", args: {} }], 1);
  assert.deepEqual(db.loadLogs("tasks").map((l) => l.name), ["T"]);
  assert.deepEqual(db.loadLogs("agents").map((l) => l.name), ["A"]);
});

test("BigInt args survive a round-trip as numeric strings", () => {
  const { db } = freshStore("bigint");
  db.saveLogs("tasks", [{ name: "T", blockNumber: 1, li: 0, txHash: "0x1", args: { budget: 10n ** 18n } }], 1);
  assert.equal(db.loadLogs("tasks")[0].args.budget, "1000000000000000000");
});

test("block times persist, which is what stops thousands of getBlock calls per boot", () => {
  const { db } = freshStore("blocktimes");
  db.saveBlockTimes([
    [100, 1_700_000_000_000],
    [101, 1_700_000_001_000],
  ]);
  const times = db.loadBlockTimes();
  assert.equal(times.get(100), 1_700_000_000_000);
  assert.equal(times.size, 2);
  // Immutable: re-writing a known block must not change it.
  db.saveBlockTimes([[100, 999]]);
  assert.equal(db.loadBlockTimes().get(100), 1_700_000_000_000);
});

test("an existing JSON log checkpoint imports without loss, and only once", () => {
  const { db, dir } = freshStore("import-logs");
  const json = path.join(dir, "chain-index-tasks.json");
  fs.writeFileSync(
    json,
    JSON.stringify({
      lastBlock: 42,
      logs: [
        { name: "First", blockNumber: 7, txHash: "0x1", args: {} },
        { name: "Second", blockNumber: 7, txHash: "0x2", args: {} },
        { name: "Third", blockNumber: 8, txHash: "0x3", args: {} },
      ],
    }),
  );
  assert.equal(db.importJson("tasks", json, "logs"), true);
  assert.deepEqual(db.loadLogs("tasks").map((l) => l.name), ["First", "Second", "Third"]);
  assert.equal(db.lastBlock("tasks"), 42, "the warm checkpoint must carry over, or the chain is re-scanned");
  // Two events in the same block must not collide on the synthesised log index.
  assert.equal(db.importJson("tasks", json, "logs"), false, "a second import would duplicate everything");
  assert.equal(db.loadLogs("tasks").length, 3);
});

test("an existing JSON record checkpoint imports without loss", () => {
  const { db, dir } = freshStore("import-records");
  const json = path.join(dir, "sub-index.json");
  fs.writeFileSync(json, JSON.stringify({ lastBlock: 9, byId: { "0xaa": { status: "ACTIVE" } } }));
  assert.equal(db.importJson("subs", json, "records"), true);
  assert.equal(db.loadRecords("subs")["0xaa"].status, "ACTIVE");
  assert.equal(db.lastBlock("subs"), 9);
});

test("a missing or corrupt JSON checkpoint is survivable, not fatal", () => {
  const { db, dir } = freshStore("corrupt");
  assert.equal(db.importJson("tasks", path.join(dir, "nope.json"), "logs"), false);
  const bad = path.join(dir, "truncated.json");
  fs.writeFileSync(bad, '{"lastBlock":5,"logs":[{"name":"A"');
  assert.equal(db.importJson("tasks", bad, "logs"), false, "a truncated file must not throw on boot");
  assert.equal(db.loadLogs("tasks").length, 0);
});

test("an unknown store is empty rather than throwing", () => {
  const { db } = freshStore("unknown");
  assert.deepEqual(db.loadLogs("never-written"), []);
  assert.deepEqual(db.loadRecords("never-written"), {});
  assert.equal(db.lastBlock("never-written"), null);
});
