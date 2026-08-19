import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  taskVerdictDigest,
  subscriptionDeliveryDigest,
  recurringDeliveryDigest,
  disputeVerdictDigest,
} from "../digests.js";

/**
 * Verdict digests decide whether money moves. Arc's live contracts verify the
 * pre-audit shape while everything deployed since verifies the hardened one, and the
 * whole difference hangs on one boolean. Getting it wrong does not fail loudly: every
 * settlement reverts with "Bad signature" and tasks silently stall with funds locked,
 * which is exactly what happened in production before the split existed.
 *
 * These tests pin both shapes against digests computed independently here, so a
 * refactor cannot quietly change what gets signed.
 */

const CHAIN = 5042002;
const BRIDGE = "0xA8C2Cd1D3dd31637e5b9138D856508444E826C3A";
const SUBS = "0x3DbA6eD862d4247A30D6dF76d438bEeC72cfb61a";
const RM = "0xD0DBF9323f7275305868f4f83AaCF1160d2B20Fd";
const DM = "0xD965F54429a83F80D46462342B24f1814FeBBf05";

const legacyCtx = {
  legacyVerdictDigest: true,
  CHAIN_ID: CHAIN,
  ADDR: { verifierBridge: BRIDGE, subscriptionManager: SUBS, recurringMarket: RM, disputeManager: DM },
};
const hardenedCtx = { ...legacyCtx, legacyVerdictDigest: false };

const taskId = "0x" + "11".repeat(32);
const hash = "0x" + "22".repeat(32);
const agent = "0x" + "33".repeat(20);
const requester = "0x" + "44".repeat(20);

test("task verdict: legacy shape is (taskId, passed, score, hash) with no domain separation", () => {
  const expected = ethers.solidityPackedKeccak256(
    ["bytes32", "bool", "uint8", "bytes32"],
    [taskId, true, 90, hash],
  );
  const actual = taskVerdictDigest(legacyCtx, {
    taskId,
    agent,
    requester,
    passed: true,
    score: 90,
    deliverableHash: hash,
  });
  assert.equal(actual, expected);
});

test("task verdict: hardened shape binds chain, contract, agent and requester", () => {
  const expected = ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
    [CHAIN, BRIDGE, taskId, agent, requester, true, 90, hash],
  );
  const actual = taskVerdictDigest(hardenedCtx, {
    taskId,
    agent,
    requester,
    passed: true,
    score: 90,
    deliverableHash: hash,
  });
  assert.equal(actual, expected);
});

test("the two task shapes differ, so a verdict cannot be replayed across deployments", () => {
  const args = { taskId, agent, requester, passed: true, score: 90, deliverableHash: hash };
  assert.notEqual(taskVerdictDigest(legacyCtx, args), taskVerdictDigest(hardenedCtx, args));
});

test("hardened task verdict changes when the payee changes (the original exploit)", () => {
  const base = { taskId, agent, requester, passed: true, score: 90, deliverableHash: hash };
  const swapped = { ...base, agent: "0x" + "55".repeat(20) };
  assert.notEqual(taskVerdictDigest(hardenedCtx, base), taskVerdictDigest(hardenedCtx, swapped));
  // The legacy shape does NOT bind the agent, which is why the hardened one exists.
  assert.equal(taskVerdictDigest(legacyCtx, base), taskVerdictDigest(legacyCtx, swapped));
});

test("subscription delivery: both shapes match an independent computation", () => {
  const args = { subId: taskId, index: 2, deliverableHash: hash, score: 88 };
  assert.equal(
    subscriptionDeliveryDigest(legacyCtx, args),
    ethers.solidityPackedKeccak256(["bytes32", "uint32", "bytes32", "uint8"], [taskId, 2, hash, 88]),
  );
  assert.equal(
    subscriptionDeliveryDigest(hardenedCtx, args),
    ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
      [CHAIN, SUBS, taskId, 2, hash, 88],
    ),
  );
});

test("recurring delivery: legacy shape reproduces the digest Arc's live contract checks", () => {
  // Taken from the production failure: plan 0xe25e54…, index 2, score 100. The
  // legacy digest is what the deployed RecurringMarket computes.
  const planId = "0xe25e540b2d8a03865c627db4ca2f284ec9db8838021dc20b27a9b8a4eb81ad12";
  const dHash = "0x736ee9f8a9cee835c69069e5f616e750817a77560adec4ceda8272f0d046252f";
  assert.equal(
    recurringDeliveryDigest(legacyCtx, { planId, index: 2, deliverableHash: dHash, score: 100 }),
    "0xd06a937a76c3740d68efcc33347d40ab4b47ceb31f75668fd3e70ab84e29e0cc",
  );
});

test("dispute verdict: both shapes match an independent computation", () => {
  assert.equal(
    disputeVerdictDigest(legacyCtx, { disputeId: taskId, upheld: true }),
    ethers.solidityPackedKeccak256(["bytes32", "bool"], [taskId, true]),
  );
  assert.equal(
    disputeVerdictDigest(hardenedCtx, { disputeId: taskId, upheld: true }),
    ethers.solidityPackedKeccak256(["uint256", "address", "bytes32", "bool"], [CHAIN, DM, taskId, true]),
  );
});

test("upholding and rejecting a dispute produce different digests", () => {
  assert.notEqual(
    disputeVerdictDigest(hardenedCtx, { disputeId: taskId, upheld: true }),
    disputeVerdictDigest(hardenedCtx, { disputeId: taskId, upheld: false }),
  );
});
