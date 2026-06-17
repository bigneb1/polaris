import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fs from "node:fs";
import "dotenv/config";

import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ADDR, ABI, provider, readTaskMeta, readAssignedAgent, requireAddresses } from "./chain.js";
import { scoreAgentWork } from "./score.js";

/**
 * Polaris verifier backend.
 *   POST /api/deliverable      store an agent's deliverable (off-chain blob)
 *   GET  /api/deliverable/:id  fetch it
 *   POST /api/verify           score with Claude → sign verdict → settle on-chain
 *
 * Holds the trusted verifier signer key; the frontend never sees it. The signed
 * verdict drives USDCEscrow release/slash via VerifierBridge.submitVerification.
 */
const PORT = process.env.PORT || 8787;
const STORE = process.env.DELIVERABLE_STORE || "./deliverables.json";
const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Simple JSON-file persistence for deliverable blobs (keyed by taskId).
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}
function saveStore(obj) {
  fs.writeFileSync(STORE, JSON.stringify(obj, null, 2));
}

app.get("/health", (_req, res) => res.json({ ok: true, signer: signerAddress() }));

app.post("/api/deliverable", (req, res) => {
  const { taskId, agentWallet, deliverable } = req.body ?? {};
  if (!taskId || !deliverable) return res.status(400).json({ error: "taskId and deliverable required" });
  const store = loadStore();
  store[taskId.toLowerCase()] = { agentWallet, deliverable, at: Date.now() };
  saveStore(store);
  res.json({ ok: true });
});

app.get("/api/deliverable/:taskId", (req, res) => {
  const store = loadStore();
  const entry = store[req.params.taskId.toLowerCase()];
  res.json({ deliverable: entry?.deliverable ?? null });
});

app.post("/api/verify", async (req, res) => {
  try {
    requireAddresses(["taskRegistry", "verifierBridge"]);
    if (!SIGNER_KEY) return res.status(500).json({ error: "VERIFIER_SIGNER_KEY not set" });

    const { taskId } = req.body ?? {};
    if (!taskId) return res.status(400).json({ error: "taskId required" });

    const meta = await readTaskMeta(taskId);
    if (!meta) return res.status(404).json({ error: "Task not found on-chain" });

    const store = loadStore();
    const entry = store[taskId.toLowerCase()];
    if (!entry?.deliverable) return res.status(400).json({ error: "No deliverable submitted for this task" });

    const agent = (await readAssignedAgent(taskId)) || entry.agentWallet;
    if (!agent) return res.status(400).json({ error: "Task has no assigned agent" });

    // 1. Score with Claude
    const verdict = await scoreAgentWork({
      taskDescription: `${meta.title}\n\n${meta.description}`,
      qualityRubric: meta.rubric,
      agentOutput: entry.deliverable,
    });

    // 2. On-chain attestation: hash the exact deliverable, then sign a verdict
    //    that binds taskId + pass/fail + score + deliverableHash.
    const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes(entry.deliverable));
    const wallet = new ethers.Wallet(SIGNER_KEY, provider);
    const inner = ethers.solidityPackedKeccak256(
      ["bytes32", "bool", "uint8", "bytes32"],
      [taskId, verdict.passed, verdict.score, deliverableHash],
    );
    const signature = await wallet.signMessage(ethers.getBytes(inner));

    // 3. Submit on-chain → releases USDC or slashes the stake, and records the
    //    deliverable attestation in VerifierBridge.
    const bridge = new ethers.Contract(ADDR.verifierBridge, ABI.verifierBridge, wallet);
    const already = await bridge.processed(taskId);
    let txHash;
    if (!already) {
      const tx = await bridge.submitVerification(
        taskId,
        agent,
        meta.requester,
        verdict.passed,
        verdict.score,
        deliverableHash,
        signature,
      );
      const receipt = await tx.wait();
      txHash = receipt.hash;
    }

    res.json({ ...verdict, deliverableHash, txHash });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ error: err.shortMessage || err.message || "Verification failed" });
  }
});

function signerAddress() {
  try {
    return SIGNER_KEY ? new ethers.Wallet(SIGNER_KEY).address : null;
  } catch {
    return null;
  }
}

// ── x402 nanopayment sub-service (Circle Gateway on Arc) ─────────────────────
// A paywalled "price oracle" an agent pays $0.01 USDC to call — demonstrates
// agent-to-agent nanopayments settled via Circle Gateway and batched on Arc
// (the literal Lepton thesis), running alongside the escrow-based task economy.
const X402_SELLER = process.env.X402_SELLER || signerAddress();
if (X402_SELLER) {
  try {
    const gateway = createGatewayMiddleware({
      sellerAddress: X402_SELLER,
      facilitatorUrl: process.env.X402_FACILITATOR || "https://gateway-api-testnet.circle.com",
      networks: [process.env.X402_NETWORK || "eip155:5042002"],
    });
    app.get("/api/oracle/price", gateway.require("$0.01"), (req, res) => {
      const pay = req.payment || {};
      res.json({
        service: "polaris-price-oracle",
        usdcQuote: 1.0,
        asOf: Date.now(),
        paidBy: pay.payer,
        network: pay.network,
        settlementId: pay.transaction,
      });
    });
    console.log(`x402 sub-service: GET /api/oracle/price ($0.01) · seller ${X402_SELLER}`);
  } catch (e) {
    console.warn("x402 sub-service disabled:", e.message);
  }
} else {
  console.log("x402 sub-service disabled (set X402_SELLER or VERIFIER_SIGNER_KEY to enable)");
}

app.listen(PORT, () => {
  console.log(`Polaris verifier on :${PORT} | signer ${signerAddress() ?? "(unset)"}`);
});
