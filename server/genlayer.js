import { ethers } from "ethers";
import { createAccount, createClient } from "genlayer-js";
import { ExecutionResult, TransactionResult, TransactionStatus } from "genlayer-js/types";
import { DEFAULT_GENLAYER_NETWORK, GENLAYER_NETWORKS } from "./genlayer-chains.js";
import { relayFinalizedVerdict } from "./verdict-relay.js";

/**
 * Every exported call takes the chain context of the network being settled
 * (`getChainCtx(networkId)` — see server/chain.js). Polaris runs one runtime per
 * network, and a case id folds the chain id in, so Arc and BOT Chain can adjudicate
 * the same task id without ever colliding on a GenLayer case. Reading the chain off
 * a module-level constant instead would silently file every BOT decision under Arc's
 * chain id and bind it to Arc's contract addresses.
 */

const NETWORKS = GENLAYER_NETWORKS;
const NETWORK = process.env.GENLAYER_NETWORK || DEFAULT_GENLAYER_NETWORK;
/**
 * Per-network adjudicator addresses. A single `GENLAYER_CONTRACT_ADDRESS` default was
 * fine while there was one GenLayer network; with two live Studio deployments it is a
 * trap, because an address deployed on Studio Next does not exist on Studionet and the
 * failure is a confusing empty read rather than a clear error.
 */
const ADJUDICATORS = {
  // Studio Next has no adjudicator yet. GenVM there rejects every published
  // py-genlayer runner header — the canonical pinned hash returns
  // "invalid_contract runner malformed" and the test/latest aliases exit 1 — for a
  // three-line contract as readily as for this one, while the identical contract,
  // SDK and header deploy cleanly on 61999. Set GENLAYER_CONTRACT_ADDRESS once the
  // network can host a contract; everything else here is already wired for it.
  studioNext: process.env.GENLAYER_STUDIO_NEXT_ADDRESS || "",
  studioDevnet: process.env.GENLAYER_STUDIO_NEXT_ADDRESS || "",
  studionet: "0xe7ef55c5bb399876119F4FBeAc8D98e0Ceb2ACD5",
};
const CONTRACT = process.env.GENLAYER_CONTRACT_ADDRESS || ADJUDICATORS[NETWORK] || "";
// Polaris intentionally uses the existing relay identity as the GenLayer
// operator unless a dedicated key is configured.
const PRIVATE_KEY = process.env.GENLAYER_PRIVATE_KEY || process.env.VERIFIER_SIGNER_KEY;

export function genlayerEnabled() {
  return !!(CONTRACT && PRIVATE_KEY && NETWORKS[NETWORK]);
}

/** What this runtime adjudicates on — surfaced by /health so it is checkable. */
export function genlayerTarget() {
  return { network: NETWORK, chainId: NETWORKS[NETWORK]?.id ?? null, adjudicator: CONTRACT || null };
}

function context() {
  if (!CONTRACT) throw new Error("GENLAYER_CONTRACT_ADDRESS not set");
  if (!PRIVATE_KEY) throw new Error("GENLAYER_PRIVATE_KEY not set");
  const chain = NETWORKS[NETWORK];
  if (!chain) throw new Error(`Unsupported GENLAYER_NETWORK: ${NETWORK}`);
  const account = createAccount(PRIVATE_KEY);
  return { account, client: createClient({ chain, account }) };
}

function evidenceHash(parts) {
  return ethers.keccak256(ethers.toUtf8Bytes(parts.join("\n\u001f\n")));
}

function caseId(chainId, kind, sourceId, evidence) {
  return ethers.id(`polaris:${kind}:${chainId}:${sourceId.toLowerCase()}:${evidence}`);
}

function sameAddress(a, b) {
  try {
    return ethers.getAddress(a) === ethers.getAddress(b);
  } catch {
    return false;
  }
}

function requireVerdictBinding(verdict, expected) {
  const exact = ["kind", "caseId", "sourceChainId", "taskId", "evidenceHash"];
  if (expected.disputeId) exact.push("disputeId");
  for (const field of exact) {
    if (String(verdict[field]) !== String(expected[field])) {
      throw new Error(`GenLayer verdict ${field} does not match submitted evidence`);
    }
  }
  for (const field of ["sourceContract", "requester", "agent"]) {
    if (!sameAddress(verdict[field], expected[field])) {
      throw new Error(`GenLayer verdict ${field} does not match submitted evidence`);
    }
  }
  return verdict;
}

async function submitAndRead(functionName, args, id) {
  const { account, client } = context();
  // Idempotent retry: a GenLayer decision may have finalized even if the Arc
  // relay failed. Reuse the stored decision instead of paying validators twice.
  const existing = await client.readContract({ address: CONTRACT, functionName: "get_case", args: [id] });
  if (typeof existing === "string" && existing) {
    return { ...JSON.parse(existing), genlayerTxHash: null, adjudicationId: id };
  }
  const txHash = await client.writeContract({
    account,
    address: CONTRACT,
    functionName,
    args,
    value: 0n,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: Number(process.env.GENLAYER_POLL_MS || 5000),
    retries: Number(process.env.GENLAYER_FINALITY_RETRIES || 240),
  });
  const transaction = await client.getTransaction({ hash: txHash });
  const execution = transaction.txExecutionResultName || transaction.tx_execution_result_name || receipt.txExecutionResultName;
  const consensus = transaction.resultName || transaction.result_name || receipt.resultName;
  if (transaction.consensus_data?.leader_receipt?.some((item) => item.execution_result === "ERROR")) {
    throw new Error("GenLayer validators finalized a GenVM execution error");
  }
  if (execution === ExecutionResult.FINISHED_WITH_ERROR || (execution && execution !== ExecutionResult.FINISHED_WITH_RETURN)) {
    throw new Error(`GenLayer adjudication failed: ${execution}`);
  }
  if (!execution && consensus !== TransactionResult.MAJORITY_AGREE && consensus !== TransactionResult.AGREE && consensus !== TransactionResult.SUCCESS) {
    throw new Error(`GenLayer adjudication failed: ${consensus || transaction.statusName || "unknown result"}`);
  }
  const raw = await client.readContract({ address: CONTRACT, functionName: "get_case", args: [id] });
  if (typeof raw !== "string" || !raw) throw new Error("GenLayer finalized without a stored verdict");
  const verdict = JSON.parse(raw);
  // The deterministic case id is the durable cross-chain decision reference;
  // txHash is retained separately for GenLayer explorer/audit UX.
  return { ...verdict, genlayerTxHash: txHash, adjudicationId: id };
}

export async function adjudicateTask(ctx, { sourceId, sourceContract = ctx.ADDR.verifierBridge, requester, agent, title, description, rubric, deliverable }) {
  const chainId = ctx.CHAIN_ID;
  const evidence = evidenceHash([title, description, rubric, deliverable]);
  const id = caseId(chainId, "task", sourceId, evidence);
  const verdict = await submitAndRead("adjudicate_task", [
    id,
    String(chainId),
    sourceContract,
    sourceId,
    requester,
    agent,
    title,
    description,
    rubric,
    deliverable,
    evidence,
  ], id);
  requireVerdictBinding(verdict, {
    kind: "task", caseId: id, sourceChainId: String(chainId), sourceContract,
    taskId: sourceId, requester, agent, evidenceHash: evidence,
  });
  const score = Number(verdict.score);
  if (!Number.isInteger(score) || score < 0 || score > 100 || typeof verdict.passed !== "boolean" || verdict.passed !== (score >= 70)) {
    throw new Error("GenLayer returned an invalid task verdict");
  }
  verdict.mirrorTxHashes = await relayFinalizedVerdict(ctx, {
    decisionId: verdict.adjudicationId, sourceContract, sourceId,
    evidenceHash: evidence, kind: 1, outcome: verdict.passed, score,
    reasoning: verdict.reasoning,
  });
  return verdict;
}

export async function adjudicateDispute(ctx, { disputeId, taskId, sourceContract = ctx.ADDR.disputeManager, requester, agent, title, description, rubric, deliverable, complaint }) {
  const chainId = ctx.CHAIN_ID;
  const evidence = evidenceHash([title, description, rubric, deliverable, complaint]);
  const id = caseId(chainId, "dispute", disputeId, evidence);
  const verdict = await submitAndRead("resolve_dispute", [
    id,
    String(chainId),
    sourceContract,
    disputeId,
    taskId,
    requester,
    agent,
    title,
    description,
    rubric,
    deliverable,
    complaint,
    evidence,
  ], id);
  requireVerdictBinding(verdict, {
    kind: "dispute", caseId: id, sourceChainId: String(chainId), sourceContract,
    disputeId, taskId, requester, agent, evidenceHash: evidence,
  });
  if (typeof verdict.upheld !== "boolean") throw new Error("GenLayer returned an invalid dispute verdict");
  verdict.mirrorTxHashes = await relayFinalizedVerdict(ctx, {
    decisionId: verdict.adjudicationId, sourceContract, sourceId: disputeId,
    evidenceHash: evidence, kind: 2, outcome: verdict.upheld,
    score: Number(verdict.confidence || 0), reasoning: verdict.reasoning,
  });
  return verdict;
}
