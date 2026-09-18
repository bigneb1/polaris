import { ethers } from "ethers";

/**
 * The two mirrors are fixed DESTINATIONS — every finalized decision lands on both,
 * whichever network it came from. What varies is the SOURCE: `sourceChainId` is the
 * chain whose contracts the decision settles, and it is bound into both the stored
 * verdict and the relay signature, so it has to come from the caller's chain context
 * rather than a module-level constant. Getting that wrong would record a BOT Chain
 * decision as an Arc one on both mirrors, and `relayOne`'s conflict check could not
 * tell the difference.
 */

const ABI = [
  "function verdicts(bytes32) view returns (uint256 sourceChainId,address sourceContract,bytes32 sourceId,bytes32 evidenceHash,uint8 kind,bool outcome,uint8 score,bytes32 reasoningHash,uint64 timestamp)",
  "function recordVerdict(bytes32 decisionId,uint256 sourceChainId,address sourceContract,bytes32 sourceId,bytes32 evidenceHash,uint8 kind,bool outcome,uint8 score,bytes32 reasoningHash,bytes signature)",
];

function targets() {
  const key = process.env.BOT_RELAY_PRIVATE_KEY || process.env.VERIFIER_SIGNER_KEY;
  if (!key) return [];
  return [
    { name: "arc", rpc: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network", chainId: Number(process.env.ARC_CHAIN_ID || 5042002), address: process.env.ARC_GENLAYER_MIRROR_ADDRESS || "0xc342dEEbB3cbF8cf761e26a94B46ddb28847460F" },
    { name: "bot", rpc: process.env.BOT_RPC_URL || "https://rpc.bohr.life", chainId: Number(process.env.BOT_CHAIN_ID || 968), address: process.env.BOT_GENLAYER_MIRROR_ADDRESS || "0xe98650A2d1007df7013379B49AdFC03A3E8C1589" },
  ].filter((target) => target.rpc && target.address).map((target) => ({ ...target, key }));
}

export function verdictMirrorsEnabled() {
  const names = new Set(targets().map((target) => target.name));
  return names.has("arc") && names.has("bot");
}

function equalHex(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function relayOne(target, verdict) {
  const provider = new ethers.JsonRpcProvider(target.rpc);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== target.chainId) throw new Error(`${target.name} relay connected to unexpected chain ${network.chainId}`);
  const wallet = new ethers.Wallet(target.key, provider);
  const mirror = new ethers.Contract(target.address, ABI, wallet);
  const existing = await mirror.verdicts(verdict.decisionId);
  if (Number(existing.timestamp) > 0) {
    if (
      Number(existing.sourceChainId) !== verdict.sourceChainId ||
      !equalHex(existing.sourceContract, verdict.sourceContract) ||
      !equalHex(existing.sourceId, verdict.sourceId) ||
      !equalHex(existing.evidenceHash, verdict.evidenceHash) ||
      Number(existing.kind) !== verdict.kind ||
      existing.outcome !== verdict.outcome ||
      Number(existing.score) !== verdict.score ||
      !equalHex(existing.reasoningHash, verdict.reasoningHash)
    ) {
      throw new Error(`${target.name} mirror contains a conflicting verdict`);
    }
    return null;
  }
  const digest = ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "uint256", "address", "bytes32", "bytes32", "uint8", "bool", "uint8", "bytes32"],
    [target.chainId, target.address, verdict.decisionId, verdict.sourceChainId, verdict.sourceContract, verdict.sourceId, verdict.evidenceHash, verdict.kind, verdict.outcome, verdict.score, verdict.reasoningHash],
  );
  const signature = await wallet.signMessage(ethers.getBytes(digest));
  const tx = await mirror.recordVerdict(
    verdict.decisionId, verdict.sourceChainId, verdict.sourceContract, verdict.sourceId,
    verdict.evidenceHash, verdict.kind, verdict.outcome, verdict.score,
    verdict.reasoningHash, signature,
  );
  await tx.wait();
  return tx.hash;
}

/**
 * The mirror stores `sourceId`/`evidenceHash`/`decisionId` as bytes32 and
 * `sourceContract` as an address. A caller that passes a local store key
 * (`<network>:<planId>#<index>`) instead of a hash fails deep inside ethers with
 * "invalid BytesLike value", AFTER validators have already been paid for the
 * adjudication. Name it here, where the caller is still obvious.
 */
function requireShapes(verdict) {
  for (const field of ["decisionId", "sourceId", "evidenceHash"]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(verdict[field]))) {
      throw new Error(`Verdict ${field} must be a 32-byte hash, got: ${verdict[field]}`);
    }
  }
  if (!ethers.isAddress(verdict.sourceContract)) {
    throw new Error(`Verdict sourceContract must be an address, got: ${verdict.sourceContract}`);
  }
}

export async function relayFinalizedVerdict(ctx, { decisionId, sourceContract, sourceId, evidenceHash, kind, outcome, score, reasoning }) {
  const configured = targets();
  if (configured.length === 0) return {};
  const verdict = {
    decisionId,
    sourceChainId: ctx.CHAIN_ID,
    sourceContract,
    sourceId,
    evidenceHash,
    kind,
    outcome,
    score,
    reasoningHash: ethers.keccak256(ethers.toUtf8Bytes(reasoning || "")),
  };
  requireShapes(verdict);
  const entries = await Promise.all(configured.map(async (target) => [target.name, await relayOne(target, verdict)]));
  return Object.fromEntries(entries);
}
