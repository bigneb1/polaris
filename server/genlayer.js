import { ethers } from "ethers";
import { createAccount, createClient } from "genlayer-js";
import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import { ExecutionResult, TransactionResult, TransactionStatus } from "genlayer-js/types";
import { ADDR, CHAIN_ID } from "./chain.js";
import { relayFinalizedVerdict } from "./verdict-relay.js";

const NETWORKS = { localnet, studionet, testnetAsimov, testnetBradbury };
const NETWORK = process.env.GENLAYER_NETWORK || "studionet";
const CONTRACT = process.env.GENLAYER_CONTRACT_ADDRESS || "0xe7ef55c5bb399876119F4FBeAc8D98e0Ceb2ACD5";
// Polaris intentionally uses the existing relay identity as the GenLayer
// operator unless a dedicated key is configured.
const PRIVATE_KEY = process.env.GENLAYER_PRIVATE_KEY || process.env.VERIFIER_SIGNER_KEY;

export function genlayerEnabled() {
  return !!(CONTRACT && PRIVATE_KEY && NETWORKS[NETWORK]);
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

function caseId(kind, sourceId, evidence) {
  return ethers.id(`polaris:${kind}:${CHAIN_ID}:${sourceId.toLowerCase()}:${evidence}`);
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

export async function adjudicateTask({ sourceId, sourceContract = ADDR.verifierBridge, requester, agent, title, description, rubric, deliverable }) {
  const evidence = evidenceHash([title, description, rubric, deliverable]);
  const id = caseId("task", sourceId, evidence);
  const verdict = await submitAndRead("adjudicate_task", [
    id,
    String(CHAIN_ID),
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
    kind: "task", caseId: id, sourceChainId: String(CHAIN_ID), sourceContract,
    taskId: sourceId, requester, agent, evidenceHash: evidence,
  });
  const score = Number(verdict.score);
  if (!Number.isInteger(score) || score < 0 || score > 100 || typeof verdict.passed !== "boolean" || verdict.passed !== (score >= 70)) {
    throw new Error("GenLayer returned an invalid task verdict");
  }
  verdict.mirrorTxHashes = await relayFinalizedVerdict({
    decisionId: verdict.adjudicationId, sourceContract, sourceId,
    evidenceHash: evidence, kind: 1, outcome: verdict.passed, score,
    reasoning: verdict.reasoning,
  });
  return verdict;
}

export async function adjudicateDispute({ disputeId, taskId, sourceContract = ADDR.disputeManager, requester, agent, title, description, rubric, deliverable, complaint }) {
  const evidence = evidenceHash([title, description, rubric, deliverable, complaint]);
  const id = caseId("dispute", disputeId, evidence);
  const verdict = await submitAndRead("resolve_dispute", [
    id,
    String(CHAIN_ID),
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
    kind: "dispute", caseId: id, sourceChainId: String(CHAIN_ID), sourceContract,
    disputeId, taskId, requester, agent, evidenceHash: evidence,
  });
  if (typeof verdict.upheld !== "boolean") throw new Error("GenLayer returned an invalid dispute verdict");
  verdict.mirrorTxHashes = await relayFinalizedVerdict({
    decisionId: verdict.adjudicationId, sourceContract, sourceId: disputeId,
    evidenceHash: evidence, kind: 2, outcome: verdict.upheld,
    score: Number(verdict.confidence || 0), reasoning: verdict.reasoning,
  });
  return verdict;
}
