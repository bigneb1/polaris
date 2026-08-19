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
 */

/** VerifierBridge.submitVerification — releases or slashes a task's escrow. */
export function taskVerdictDigest(ctx, { taskId, agent, requester, passed, score, deliverableHash }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bool", "uint8", "bytes32"],
      [taskId, passed, score, deliverableHash],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
    [ctx.CHAIN_ID, ctx.ADDR.verifierBridge, taskId, agent, requester, passed, score, deliverableHash],
  );
}

/** SubscriptionManager.recordDelivery — releases one slice of a prepaid plan. */
export function subscriptionDeliveryDigest(ctx, { subId, index, deliverableHash, score }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint32", "bytes32", "uint8"],
      [subId, index, deliverableHash, score],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
    [ctx.CHAIN_ID, ctx.ADDR.subscriptionManager, subId, index, deliverableHash, score],
  );
}

/** RecurringMarket.recordDelivery — releases one drop of an auctioned plan. */
export function recurringDeliveryDigest(ctx, { planId, index, deliverableHash, score }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint32", "bytes32", "uint8"],
      [planId, index, deliverableHash, score],
    );
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
    [ctx.CHAIN_ID, ctx.ADDR.recurringMarket, planId, index, deliverableHash, score],
  );
}

/** DisputeManager.resolveDispute — refunds or forfeits the dispute bond. */
export function disputeVerdictDigest(ctx, { disputeId, upheld }) {
  if (ctx.legacyVerdictDigest) {
    return ethers.solidityPackedKeccak256(["bytes32", "bool"], [disputeId, upheld]);
  }
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "bool"],
    [ctx.CHAIN_ID, ctx.ADDR.disputeManager, disputeId, upheld],
  );
}
