import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { verifyAgentSignature } from "../auth.js";

/**
 * Write endpoints that accept an identity must prove it.
 *
 * Three routes took an address from the request body and trusted it. The worst was
 * /api/agent-meta, which sets where Polaris POSTs an agent's work: anyone could repoint any
 * agent at a server they controlled and receive its briefs, with an Authorization header of
 * their choosing. /api/rating checked engagement on chain but never that the caller was the
 * requester — and every field it checked is public chain data, so ratings were forgeable by
 * anyone. /api/flag-agent stored `reporter` verbatim, so complaints could be filed in a
 * stranger's name.
 *
 * These pin the message formats the server now requires. They use real signatures rather
 * than a stub, because the thing under test is precisely whether a real one is demanded.
 */
const agent = ethers.Wallet.createRandom();
const attacker = ethers.Wallet.createRandom();

test("agent-meta: the agent's own signature is accepted", async () => {
  const msg = `polaris-agent-meta:${agent.address.toLowerCase()}`;
  assert.equal(await verifyAgentSignature(msg, await agent.signMessage(msg), agent.address), true);
});

test("agent-meta: another wallet's signature is refused", async () => {
  // The hijack: attacker signs, claims to be the agent.
  const msg = `polaris-agent-meta:${agent.address.toLowerCase()}`;
  assert.equal(await verifyAgentSignature(msg, await attacker.signMessage(msg), agent.address), false);
});

test("agent-meta: a signature for a DIFFERENT agent does not transfer", async () => {
  const other = ethers.Wallet.createRandom();
  const msgForOther = `polaris-agent-meta:${other.address.toLowerCase()}`;
  const sig = await other.signMessage(msgForOther);
  // Replaying it against our agent's message must fail.
  const msgForUs = `polaris-agent-meta:${agent.address.toLowerCase()}`;
  assert.equal(await verifyAgentSignature(msgForUs, sig, agent.address), false);
});

test("rating: bound to the task id, so one signature cannot rate every task", async () => {
  const taskId = "0xabc123";
  const msg = `polaris-rating:${taskId}`;
  const sig = await agent.signMessage(msg);
  assert.equal(await verifyAgentSignature(msg, sig, agent.address), true);
  // The same signature must not validate a different task.
  assert.equal(await verifyAgentSignature("polaris-rating:0xdef456", sig, agent.address), false);
});

test("flag: bound to the agent being flagged", async () => {
  const target = "0x1111111111111111111111111111111111111111";
  const msg = `polaris-flag:${target}`;
  const sig = await agent.signMessage(msg);
  assert.equal(await verifyAgentSignature(msg, sig, agent.address), true);
  assert.equal(await verifyAgentSignature("polaris-flag:0x2222222222222222222222222222222222222222", sig, agent.address), false);
});

test("a missing signature is refused, not treated as absent-and-fine", async () => {
  const msg = `polaris-agent-meta:${agent.address.toLowerCase()}`;
  assert.equal(await verifyAgentSignature(msg, undefined, agent.address), false);
  assert.equal(await verifyAgentSignature(msg, "", agent.address), false);
  assert.equal(await verifyAgentSignature(msg, "0xdeadbeef", agent.address), false);
});
