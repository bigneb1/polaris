import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fs from "node:fs";
import "dotenv/config";

import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ADDR, ABI, provider, readTaskMeta, readAssignedAgent, requireAddresses } from "./chain.js";
import { scoreAgentWork } from "./score.js";
import { getIndex } from "./indexer.js";
import { listSubscriptions, getDelivery } from "./subscriptions.js";
import {
  ucEnabled,
  createSession,
  refreshSession,
  initChallenge,
  getWallet,
  contractExecutionChallenge,
  emailDeviceToken,
  walletByToken,
  createWalletForToken,
  pinSetupByToken,
  contractExecutionChallengeByToken,
} from "./circle-user.js";

/**
 * Polaris verifier backend.
 *   POST /api/deliverable      store an agent's deliverable (off-chain blob)
 *   GET  /api/deliverable/:id  fetch it
 *   POST /api/verify           score with our algorithm → sign verdict → settle on-chain
 *
 * Holds the trusted verifier signer key; the frontend never sees it. The signed
 * verdict drives USDCEscrow release/slash via VerifierBridge.submitVerification.
 */
const PORT = process.env.PORT || 8787;
const STORE = process.env.DELIVERABLE_STORE || "./deliverables.json";
const ASSET_STORE = process.env.ASSET_STORE || "./assets.json";
const AGENT_META_STORE = process.env.AGENT_META_STORE || "./agent-meta.json";
const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" })); // allow small base64 images

// Asset store: optional cover/avatar images keyed by taskId or agent wallet.
// Off-chain (the contracts don't carry images); merged into /api/index.
function loadAssets() {
  try {
    return JSON.parse(fs.readFileSync(ASSET_STORE, "utf8"));
  } catch {
    return {};
  }
}
function saveAssets(obj) {
  fs.writeFileSync(ASSET_STORE, JSON.stringify(obj, null, 2));
}

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

// Server-side chain index (tasks/agents/bids/activity) so the browser doesn't
// have to make hundreds of eth_getLogs calls against the public RPC. Chain
// stays the source of truth; this is a reliable read cache.
app.get("/api/index", async (_req, res) => {
  try {
    res.json(await getIndex());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Store an image for a task (by taskId) or agent (by wallet). `id` is lowercased.
app.post("/api/asset", (req, res) => {
  const { id, dataUri } = req.body ?? {};
  if (!id || typeof dataUri !== "string" || !dataUri.startsWith("data:image/")) {
    return res.status(400).json({ error: "id and an image dataUri are required" });
  }
  if (dataUri.length > 4_000_000) return res.status(413).json({ error: "image too large (max ~3MB)" });
  const assets = loadAssets();
  assets[String(id).toLowerCase()] = dataUri;
  saveAssets(assets);
  res.json({ ok: true });
});

app.get("/api/asset/:id", (req, res) => {
  const a = loadAssets()[String(req.params.id).toLowerCase()];
  if (!a) return res.status(404).json({ error: "not found" });
  res.json({ dataUri: a });
});

// Agent off-chain metadata (service endpoint + optional auth header) keyed by
// wallet. This is how Polaris reaches an agent's runtime (which lives elsewhere);
// the on-chain registry only carries identity/stake. Merged into /api/index.
function loadAgentMeta() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_META_STORE, "utf8"));
  } catch {
    return {};
  }
}
app.post("/api/agent-meta", (req, res) => {
  const { wallet, endpoint, auth } = req.body ?? {};
  if (!wallet || typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint)) {
    return res.status(400).json({ error: "wallet and an http(s) endpoint are required" });
  }
  if (endpoint.length > 2048) return res.status(413).json({ error: "endpoint too long" });
  const store = loadAgentMeta();
  store[String(wallet).toLowerCase()] = { endpoint, auth: typeof auth === "string" ? auth : "", at: Date.now() };
  fs.writeFileSync(AGENT_META_STORE, JSON.stringify(store, null, 2));
  res.json({ ok: true });
});

app.post("/api/deliverable", (req, res) => {
  const { taskId, agentWallet, deliverable } = req.body ?? {};
  if (!taskId || !deliverable) return res.status(400).json({ error: "taskId and deliverable required" });
  const store = loadStore();
  const prev = store[taskId.toLowerCase()] || {};
  // Preserve attempt history across resubmissions (used by the review flow).
  store[taskId.toLowerCase()] = { agentWallet, deliverable, at: Date.now(), attempts: prev.attempts || 0 };
  saveStore(store);
  res.json({ ok: true });
});

app.get("/api/deliverable/:taskId", (req, res) => {
  const store = loadStore();
  const entry = store[req.params.taskId.toLowerCase()];
  res.json({ deliverable: entry?.deliverable ?? null });
});

// ── Recurring tasks / subscriptions (Phase A) ────────────────────────────────
app.get("/api/subscriptions", async (_req, res) => {
  try {
    res.json({ subscriptions: await listSubscriptions() });
  } catch (e) {
    res.status(500).json({ error: e.message, subscriptions: [] });
  }
});

app.get("/api/sub-deliverable/:subId/:index", (req, res) => {
  const d = getDelivery(req.params.subId, Number(req.params.index));
  res.json({ deliverable: d?.text ?? null, score: d?.score ?? null });
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

    // 1. Score with our algorithm
    const verdict = await scoreAgentWork({
      taskDescription: `${meta.title}\n\n${meta.description}`,
      qualityRubric: meta.rubric,
      agentOutput: entry.deliverable,
    });

    const wallet = new ethers.Wallet(SIGNER_KEY, provider);
    const bridge = new ethers.Contract(ADDR.verifierBridge, ABI.verifierBridge, wallet);
    const already = await bridge.processed(taskId);
    if (already) return res.json({ ...verdict, status: "settled", note: "already settled onchain" });

    const settle = async () => {
      const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes(entry.deliverable));
      const inner = ethers.solidityPackedKeccak256(
        ["bytes32", "bool", "uint8", "bytes32"],
        [taskId, verdict.passed, verdict.score, deliverableHash],
      );
      const signature = await wallet.signMessage(ethers.getBytes(inner));
      const tx = await bridge.submitVerification(taskId, agent, meta.requester, verdict.passed, verdict.score, deliverableHash, signature);
      const receipt = await tx.wait();
      return { deliverableHash, txHash: receipt.hash };
    };

    // ── PASS: release USDC + record attestation ─────────────────────────────
    if (verdict.passed) {
      const out = await settle();
      return res.json({ ...verdict, status: "released", ...out });
    }

    // ── FAIL: reject-with-feedback first; slash only on a late, final failure ─
    // Rules: a submission that fails is REJECTED (not slashed) and the agent gets
    // feedback to retry, capped at MAX_ATTEMPTS. The agent is only SLASHED if it
    // has used all attempts AND burned more than SLASH_TIME_FRACTION of the task
    // window — so quick early failures cost nothing but stake-risk grows late.
    const MAX_ATTEMPTS = Number(process.env.MAX_REVIEW_ATTEMPTS || 3);
    const SLASH_TIME_FRACTION = Number(process.env.SLASH_TIME_FRACTION || 0.5);

    const attempts = (entry.attempts || 0) + 1;
    entry.attempts = attempts;
    entry.lastReason = verdict.reasoning;
    store[taskId.toLowerCase()] = entry;
    saveStore(store);

    // Elapsed fraction of the task window (createdAt..deadline), read on-chain.
    let elapsedFraction = 1;
    try {
      const t = await new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider).tasks(taskId);
      const createdMs = Number(t.createdAt) * 1000;
      const total = meta.deadline - createdMs;
      if (total > 0) elapsedFraction = (Date.now() - createdMs) / total;
    } catch {
      /* fall back to slash-eligible if timing unreadable */
    }

    const slashEligible = attempts >= MAX_ATTEMPTS && elapsedFraction > SLASH_TIME_FRACTION;
    if (slashEligible) {
      const out = await settle(); // passed=false → escrow refund to requester + stake slash
      return res.json({ ...verdict, status: "slashed", attempts, elapsedFraction, ...out });
    }

    // Rejected: return the task to the market (reopen) so any agent can re-bid,
    // unless the deadline has passed (then leave it for slashOnTimeout). USDC
    // stays escrowed; the agent is NOT slashed.
    let reopened = false;
    if (meta.deadline > Date.now()) {
      try {
        const tr = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, wallet);
        const tx = await tr.reopenTask(taskId);
        await tx.wait();
        reopened = true;
      } catch (e) {
        console.error("reopenTask failed:", e.shortMessage || e.message);
      }
    }
    return res.json({
      ...verdict,
      status: "rejected",
      attempts,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
      canRetry: attempts < MAX_ATTEMPTS,
      reopened,
      feedback: verdict.reasoning,
      elapsedFraction,
    });
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

// ── Circle user-controlled wallets (PIN/email) — human "extra connect" ──────
if (ucEnabled()) {
  app.get("/api/uc/enabled", (_req, res) => res.json({ enabled: true }));

  app.post("/api/uc/session", async (_req, res) => {
    try {
      res.json(await createSession());
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/uc/refresh", async (req, res) => {
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
      res.json(await refreshSession(userId));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/uc/init", async (req, res) => {
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
      res.json(await initChallenge(userId));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/uc/wallet", async (req, res) => {
    const { userId } = req.query ?? {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
      res.json((await getWallet(userId)) ?? {});
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/uc/execute", async (req, res) => {
    const { userId, userToken, walletId, contractAddress, abiFunctionSignature, abiParameters } = req.body ?? {};
    if (!walletId || !contractAddress || !abiFunctionSignature || (!userId && !userToken)) {
      return res.status(400).json({ error: "walletId, contractAddress, abiFunctionSignature, and userId or userToken required" });
    }
    try {
      const out = userToken
        ? await contractExecutionChallengeByToken(userToken, walletId, contractAddress, abiFunctionSignature, abiParameters ?? [])
        : await contractExecutionChallenge(userId, walletId, contractAddress, abiFunctionSignature, abiParameters ?? []);
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ── Email OTP login (the auth mode enabled in the Circle Console) ──────────
  app.post("/api/uc/email-token", async (req, res) => {
    const { deviceId, email } = req.body ?? {};
    if (!deviceId || !email) return res.status(400).json({ error: "deviceId and email required" });
    try {
      res.json(await emailDeviceToken(deviceId, email));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/uc/wallet-by-token", async (req, res) => {
    const { userToken } = req.body ?? {};
    if (!userToken) return res.status(400).json({ error: "userToken required" });
    try {
      res.json((await walletByToken(userToken)) ?? {});
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/uc/create-wallet", async (req, res) => {
    const { userToken } = req.body ?? {};
    if (!userToken) return res.status(400).json({ error: "userToken required" });
    try {
      res.json(await createWalletForToken(userToken));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // First-login PIN setup + wallet creation for email users (by userToken).
  app.post("/api/uc/pin-setup", async (req, res) => {
    const { userToken } = req.body ?? {};
    if (!userToken) return res.status(400).json({ error: "userToken required" });
    try {
      res.json(await pinSetupByToken(userToken));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  console.log("Circle user-controlled wallets: POST /api/uc/{session,init,email-token,wallet-by-token,create-wallet,execute} enabled");
} else {
  console.log("Circle user-controlled wallets disabled (set CIRCLE_UC_API_KEY + CIRCLE_UC_ENTITY_SECRET)");
}

app.listen(PORT, () => {
  console.log(`Polaris verifier on :${PORT} | signer ${signerAddress() ?? "(unset)"}`);
});
