import { ethers } from "ethers";

/**
 * Verdict digests — built to match the CONTRACT THAT IS ACTUALLY DEPLOYED.
 *
 * Every money-moving contract here settles on an ECDSA signature over a digest of
 * the verdict. Polaris's contracts were later hardened (docs/AUDIT_REPORT.md,
 * Security #1 and #5) to bind two more things into that digest:
 *
 *   - `block.chainid` and `address(this)`, so a verdict signed for one chain or one
 *     contract instance cannot be replayed against another;
 *   - for task verification, the `agent` and `requester` addresses, closing an
 *     exploit where a valid signature could be replayed with a different payee.
 *
 * Those fixes are in `contracts/` and covered by the test suite — but the Arc
 * deployment predates them and was never replaced, because redeploying would orphan
 * every existing task, agent stake and escrowed subscription on that chain. Its live
 * contracts still verify the original, narrower digests (confirmed against the
 * verified source on Arcscan for all four).
 *
 * So the digest is a property of the DEPLOYMENT, not of the repo, and this module
 * makes that explicit rather than letting the two silently diverge. Signing the
 * hardened digest against Arc's live contracts fails every settlement with "Bad
 * signature" — the runtime produces a technically better verdict that the contract
 * cannot accept, and tasks stall with funds locked in escrow.
 *
 * `ctx.legacyVerdictDigest` (see server/networks.js) selects the shape. New
 * deployments — BOT Chain, and Arc whenever it is redeployed — use the hardened
 * digests, and flipping that one flag is the whole migration.
 *
 * The GenLayer migration adds a THIRD tier for the same reason. Contracts in
 * `contracts/` now bind the finalized GenLayer decision id into the digest (and
 * require it non-zero), but nothing with that ABI is deployed on any network yet —
 * every live DisputeManager, VerifierBridge, RecurringMarket and SubscriptionManager
 * still has the four-argument signature. `ctx.genlayerDecisionBinding` selects it, so
 * the runtime can adjudicate on GenLayer and mirror the receipt today, against the
 * contracts that are actually out there, and each network flips the flag on the day
 * it is redeployed. Without this the runtime would have to ship in lockstep with a
 * five-contract redeploy on three chains, including BOT mainnet.
 */

/**
 * The contracts reject a zero decision id outright ("Missing GenLayer decision"), so a
 * missing one must fail here, where the caller is still named, rather than as an opaque
 * revert after the adjudication has already been paid for.
 */
function requireDecision(genLayerDecisionId) {
  if (!genLayerDecisionId || /^0x0{64}$/.test(genLayerDecisionId)) {
    throw new Error("A GenLayer decision id is required to sign a verdict on this deployment");
  }
  return genLayerDecisionId;
}

/** VerifierBridge.submitVerification — releases or slashes a task's escrow. */
export function taskVerdictDigest(ctx, { taskId, agent, requester, passed, score, deliverableHash, genLayerDecisionId }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bool", "uint8", "bytes32"],
      [taskId, passed, score, deliverableHash],
    );
  }
  if (!ctx.genlayerDecisionBinding) {
    return ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
      [ctx.CHAIN_ID, ctx.ADDR.verifierBridge, taskId, agent, requester, passed, score, deliverableHash],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32", "bytes32"],
    [ctx.CHAIN_ID, ctx.ADDR.verifierBridge, taskId, agent, requester, passed, score, deliverableHash, requireDecision(genLayerDecisionId)],
  );
}

/** SubscriptionManager.recordDelivery — releases one slice of a prepaid plan. */
export function subscriptionDeliveryDigest(ctx, { subId, index, deliverableHash, score, genLayerDecisionId }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint32", "bytes32", "uint8"],
      [subId, index, deliverableHash, score],
    );
  }
  if (!ctx.genlayerDecisionBinding) {
    return ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
      [ctx.CHAIN_ID, ctx.ADDR.subscriptionManager, subId, index, deliverableHash, score],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8", "bytes32"],
    [ctx.CHAIN_ID, ctx.ADDR.subscriptionManager, subId, index, deliverableHash, score, requireDecision(genLayerDecisionId)],
  );
}

/** RecurringMarket.recordDelivery — releases one drop of an auctioned plan. */
export function recurringDeliveryDigest(ctx, { planId, index, deliverableHash, score, genLayerDecisionId }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint32", "bytes32", "uint8"],
      [planId, index, deliverableHash, score],
    );
  }
  if (!ctx.genlayerDecisionBinding) {
    return ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
      [ctx.CHAIN_ID, ctx.ADDR.recurringMarket, planId, index, deliverableHash, score],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8", "bytes32"],
    [ctx.CHAIN_ID, ctx.ADDR.recurringMarket, planId, index, deliverableHash, score, requireDecision(genLayerDecisionId)],
  );
}

/** DisputeManager.resolveDispute — refunds or forfeits the dispute bond. */
export function disputeVerdictDigest(ctx, { disputeId, upheld, genLayerDecisionId }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(["bytes32", "bool"], [disputeId, upheld]);
  }
  if (!ctx.genlayerDecisionBinding) {
    return ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "bool"],
      [ctx.CHAIN_ID, ctx.ADDR.disputeManager, disputeId, upheld],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "bool", "bytes32"],
    [ctx.CHAIN_ID, ctx.ADDR.disputeManager, disputeId, upheld, requireDecision(genLayerDecisionId)],
  );
}
