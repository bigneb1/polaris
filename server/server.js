import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fs from "node:fs";
import "dotenv/config";

import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ADDR, ABI, CHAIN_ID, provider, readTaskMeta, readAssignedAgent, requireAddresses } from "./chain.js";
import { verifyAgentSignature, timingSafeEqualStr } from "./auth.js";
import { rateLimit } from "./guard.js";
import { adjudicateDispute, adjudicateTask, genlayerEnabled } from "./genlayer.js";
import { verdictMirrorsEnabled } from "./verdict-relay.js";
import { getIndex } from "./indexer.js";
import { listSubscriptions, getDelivery } from "./subscriptions.js";
import { resolveDispute, listReworks, markReworkDone } from "./disputes.js";
import { registerHosted, listHosted } from "./hosted.js";
import { listPlans, getDelivery as getPlanDelivery } from "./recurring.js";
import { storePath } from "./store-path.js";
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
 *   POST /api/verify           finalize GenLayer verdict → relay → settle on Arc
 *
 * GenLayer validator consensus owns the subjective verdict. This backend waits
 * for finality and only relays the result to Arc's VerifierBridge.
 */
const PORT = process.env.PORT || 8787;
const STORE = storePath("DELIVERABLE_STORE", "deliverables.json");
const ASSET_STORE = storePath("ASSET_STORE", "assets.json");
const AGENT_META_STORE = storePath("AGENT_META_STORE", "agent-meta.json");
const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;
const verifyCooldown = new Map(); // taskId(lower) -> ms of last /api/verify attempt
const VERIFY_COOLDOWN_MS = Number(process.env.VERIFY_COOLDOWN_MS || 10_000);

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

app.get("/health", (_req, res) => res.json({ ok: true, signer: signerAddress(), genlayer: genlayerEnabled(), verdictMirrors: verdictMirrorsEnabled() }));

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
// No per-caller identity to check ownership against (task/agent ids are public
// on-chain data), so the mitigation is bounding write volume the same way
// /api/verify is bounded: a fixed-window per-IP rate limit from guard.js.
const assetWriteLimit = rateLimit({ windowMs: 60_000, max: 20, name: "asset upload" });
app.post("/api/asset", assetWriteLimit, (req, res) => {
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
// Same reasoning as /api/asset above: writes are keyed by a public wallet
// address with nothing to sign against yet, so bound abuse with a rate limit.
const agentMetaWriteLimit = rateLimit({ windowMs: 60_000, max: 20, name: "agent-meta" });
app.post("/api/agent-meta", agentMetaWriteLimit, (req, res) => {
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

// Anyone who knows a taskId can see it (tasks are public on-chain), so submitting
// a deliverable "as" an arbitrary agent used to be completely unauthenticated —
// an attacker could force a real agent through the reject/slash flow with a
// garbage submission. Now: (1) the stored agentWallet is always the on-chain
// assigned agent, never client-supplied, and (2) if the caller can produce a
// signature (raw-key swarm, hosted personas, or a browser wallet that supports
// EIP-191/ERC-1271 signing) it's verified against that agent before accepting.
// Callers that cannot yet produce a signature (Circle MPC agent wallets — see
// server/auth.js) fall back to an unsigned submission, but once a *verified*
// deliverable exists for a task it can never be overwritten by an unsigned one.
app.post("/api/deliverable", async (req, res) => {
  try {
    const { taskId, agentWallet, deliverable, signature } = req.body ?? {};
    if (!taskId || !deliverable) return res.status(400).json({ error: "taskId and deliverable required" });

    const assignedAgent = await readAssignedAgent(taskId);
    if (!assignedAgent) return res.status(400).json({ error: "Task has no assigned agent on-chain yet" });
    if (agentWallet && String(agentWallet).toLowerCase() !== assignedAgent.toLowerCase()) {
      return res.status(403).json({ error: "agentWallet is not the on-chain assigned agent for this task" });
    }

    const store = loadStore();
    const key = taskId.toLowerCase();
    const prev = store[key] || {};

    let verified = false;
    if (signature) {
      verified = await verifyAgentSignature(`polaris-deliverable:${key}`, signature, assignedAgent);
      if (!verified) return res.status(403).json({ error: "Invalid signature for the assigned agent" });
    } else if (prev.verified) {
      return res.status(403).json({ error: "A verified deliverable already exists; resubmission requires a valid signature" });
    }

    // Preserve attempt history across resubmissions (used by the review flow).
    store[key] = { agentWallet: assignedAgent, deliverable, at: Date.now(), attempts: prev.attempts || 0, verified };
    saveStore(store);
    res.json({ ok: true, verified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reading a deliverable requires proof the caller is the task's on-chain
// requester or its assigned agent — a short-lived signed token (max 15 min),
// not a full re-sign on every fetch. `message = polaris-view:{taskId}:{expiry}`.
app.get("/api/deliverable/:taskId", async (req, res) => {
  try {
    const { viewer, expiry, signature } = req.query;
    const taskId = req.params.taskId;
    if (!viewer || !expiry || !signature) {
      return res.status(401).json({ error: "viewer, expiry, and signature query params are required" });
    }
    const expiryMs = Number(expiry);
    const MAX_TOKEN_MS = 15 * 60 * 1000;
    if (!Number.isFinite(expiryMs) || expiryMs < Date.now() || expiryMs > Date.now() + MAX_TOKEN_MS) {
      return res.status(401).json({ error: "expired or invalid view token" });
    }
    const ok = await verifyAgentSignature(`polaris-view:${taskId.toLowerCase()}:${expiryMs}`, signature, String(viewer));
    if (!ok) return res.status(403).json({ error: "invalid signature" });

    const [meta, assignedAgent] = await Promise.all([readTaskMeta(taskId), readAssignedAgent(taskId)]);
    const v = String(viewer).toLowerCase();
    const isRequester = meta && meta.requester.toLowerCase() === v;
    const isAgent = assignedAgent && assignedAgent.toLowerCase() === v;
    if (!isRequester && !isAgent) return res.status(403).json({ error: "not authorized to view this deliverable" });

    const store = loadStore();
    const entry = store[taskId.toLowerCase()];
    res.json({ deliverable: entry?.deliverable ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── Recurring market (auctioned recurring plans) ─────────────────────────────
app.get("/api/recurring-plans", async (_req, res) => {
  try {
    res.json({ plans: await listPlans() });
  } catch (e) {
    res.status(500).json({ error: e.message, plans: [] });
  }
});
app.get("/api/recurring-deliverable/:planId/:index", (req, res) => {
  const d = getPlanDelivery(req.params.planId, Number(req.params.index));
  res.json({ deliverable: d?.text ?? null, score: d?.score ?? null });
});

// Per-delivery dispute on a recurring plan: GenLayer's validator jury re-judges THIS delivery's
// deliverable against the plan brief. Advisory/off-chain (the drop was already
// released per pay-per-delivery); an upheld verdict flags the agent and the
// requester can cancel the plan to reclaim the remaining escrow.
const RD_DISPUTE_STORE = storePath("RD_DISPUTE_STORE", "recurring-disputes.json");
function loadRDisputes() {
  try {
    return JSON.parse(fs.readFileSync(RD_DISPUTE_STORE, "utf8"));
  } catch {
    return {};
  }
}
app.post("/api/recurring-dispute", async (req, res) => {
  try {
    const { planId, index, complaint, reporter } = req.body || {};
    if (!planId || index == null) return res.status(400).json({ error: "planId + index required" });
    const d = getPlanDelivery(planId, Number(index));
    if (!d?.text) return res.status(404).json({ error: "No deliverable found for that delivery yet." });
    const plan = (await listPlans()).find((p) => p.planId.toLowerCase() === String(planId).toLowerCase());
    if (!plan) return res.status(404).json({ error: "Plan not found." });
    const verdict = await adjudicateDispute({
      disputeId: ethers.id(`recurring:${planId}:${index}:${complaint || ""}`),
      taskId: planId,
      sourceContract: ADDR.recurringMarket,
      requester: plan.requester,
      agent: plan.agent,
      title: plan.title,
      description: plan.brief,
      rubric: plan.rubric,
      deliverable: d.text,
      complaint: complaint || "(no written complaint provided)",
    });
    const upheld = !!verdict.upheld;
    const juryNote = String(verdict.reasoning || "").slice(0, 300);
    const store = loadRDisputes();
    store[`${planId}#${index}`] = { planId, index: Number(index), complaint: (complaint || "").slice(0, 500), upheld, juryNote, genLayerDecisionId: verdict.adjudicationId, genlayerTxHash: verdict.genlayerTxHash, reporter: reporter || null, atMs: Date.now() };
    try {
      fs.writeFileSync(RD_DISPUTE_STORE, JSON.stringify(store));
    } catch {
      /* best-effort */
    }
    res.json({ upheld, juryNote, genLayerDecisionId: verdict.adjudicationId, genlayerTxHash: verdict.genlayerTxHash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/recurring-disputes/:planId", (req, res) => {
  const store = loadRDisputes();
  const pid = String(req.params.planId).toLowerCase();
  const out = {};
  for (const v of Object.values(store)) if (String(v.planId).toLowerCase() === pid) out[v.index] = v;
  res.json({ disputes: out });
});

// ── Hosted persona agents (Phase B) ──────────────────────────────────────────
app.post("/api/hosted-agent", (req, res) => {
  try {
    const { name, capabilities, systemPrompt, owner } = req.body || {};
    if (!name || !capabilities) return res.status(400).json({ error: "name + capabilities required" });
    res.json(registerHosted({ name, capabilities, systemPrompt, owner }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/hosted-agents", (req, res) => {
  res.json({ agents: listHosted(req.query.owner) });
});

// ── Disputes + AI jury (Phase C) ─────────────────────────────────────────────
// After the requester opens a dispute on-chain, this runs the jury and settles it.
app.post("/api/dispute/resolve", async (req, res) => {
  try {
    const { disputeId, reason } = req.body || {};
    if (!disputeId) return res.status(400).json({ error: "disputeId required" });
    const result = await resolveDispute(disputeId, reason || "");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rework queue — an upheld dispute asks the assigned agent to redo the work.
// The swarm polls this and re-produces the deliverable, then marks it done.
app.get("/api/reworks", (_req, res) => res.json({ reworks: listReworks() }));
app.post("/api/rework-done", (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "taskId required" });
  markReworkDone(taskId);
  res.json({ ok: true });
});

// ── Ratings (Phase C) — off-chain feedback after a task completes ─────────────
const RATINGS_STORE = storePath("RATINGS_STORE", "ratings.json");
function loadRatings() {
  try {
    return JSON.parse(fs.readFileSync(RATINGS_STORE, "utf8"));
  } catch {
    return {};
  }
}
// A rating must reference a real, SETTLED task where `rater` was the requester
// and `agent` was the assigned agent — closes off unlimited fake reviews from
// any freshly-created wallet (Play-Store-style reviews need proof of a real
// transaction, not just a wallet address).
const TASK_STATUS_SETTLED = 4;
app.post("/api/rating", async (req, res) => {
  try {
    const { agent, taskId, rater, stars, comment } = req.body || {};
    if (!agent || !taskId || !rater || !(stars >= 1 && stars <= 5)) {
      return res.status(400).json({ error: "agent + taskId + rater + stars(1-5) required" });
    }
    const reg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);
    const t = await reg.tasks(taskId);
    if (Number(t.status) !== TASK_STATUS_SETTLED) return res.status(403).json({ error: "Task is not settled yet" });
    if (t.requester.toLowerCase() !== String(rater).toLowerCase())
      return res.status(403).json({ error: "Only the task's requester can rate it" });
    if (t.assignedAgent.toLowerCase() !== String(agent).toLowerCase())
      return res.status(403).json({ error: "agent does not match the task's assigned agent" });

    const store = loadRatings();
    const key = agent.toLowerCase();
    store[key] = store[key] || [];
    // One rating per (task, rater); replace if it exists.
    store[key] = store[key].filter((r) => !(r.taskId === taskId && r.rater === rater));
    store[key].push({ taskId, rater, stars: Number(stars), comment: (comment || "").slice(0, 500), atMs: Date.now() });
    try {
      fs.writeFileSync(RATINGS_STORE, JSON.stringify(store));
    } catch {
      /* best-effort */
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/ratings/:agent", (req, res) => {
  const list = loadRatings()[req.params.agent.toLowerCase()] || [];
  const avg = list.length ? list.reduce((s, r) => s + r.stars, 0) / list.length : 0;
  res.json({ ratings: list, avg, count: list.length });
});

// ── Agent flags — a user reports an agent with a reason; the platform reviews it.
const FLAGS_STORE = storePath("FLAGS_STORE", "flags.json");
function loadFlags() {
  try {
    return JSON.parse(fs.readFileSync(FLAGS_STORE, "utf8"));
  } catch {
    return {};
  }
}
app.post("/api/flag-agent", (req, res) => {
  const { agent, reporter, reason } = req.body || {};
  if (!ethers.isAddress(agent) || !(reason || "").trim())
    return res.status(400).json({ error: "valid agent address + reason required" });
  const store = loadFlags();
  const key = agent.toLowerCase();
  store[key] = store[key] || [];
  // One open flag per (agent, reporter): replace an earlier pending one.
  store[key] = store[key].filter((f) => !(f.reporter === reporter && f.status === "pending"));
  store[key].push({
    reporter: reporter || null,
    reason: String(reason).slice(0, 1000),
    status: "pending",
    atMs: Date.now(),
  });
  try {
    fs.writeFileSync(FLAGS_STORE, JSON.stringify(store));
  } catch {
    /* best-effort */
  }
  res.json({ ok: true, count: store[key].length });
});
// Public: how many open flags an agent has (surface a "under review" hint).
app.get("/api/flags/:agent", (req, res) => {
  const list = loadFlags()[req.params.agent.toLowerCase()] || [];
  res.json({ count: list.filter((f) => f.status === "pending").length });
});
// Operator-only: the full flag queue for review (guarded by ADMIN_SECRET, sent
// as a header rather than a query string so it never lands in server access
// logs or browser history).
app.get("/api/flags", (req, res) => {
  const provided = req.get("x-admin-secret") || "";
  if (!process.env.ADMIN_SECRET || !timingSafeEqualStr(provided, process.env.ADMIN_SECRET))
    return res.status(403).json({ error: "Forbidden" });
  res.json({ flags: loadFlags() });
});

// ── Verification tiers (Phase D) — operator-only grant via the on-chain admin key
app.post("/api/admin/set-badge", async (req, res) => {
  try {
    const { secret, agent, tier, note } = req.body || {};
    if (!process.env.ADMIN_SECRET || !timingSafeEqualStr(secret || "", process.env.ADMIN_SECRET))
      return res.status(403).json({ error: "Forbidden" });
    if (!SIGNER_KEY) return res.status(500).json({ error: "VERIFIER_SIGNER_KEY not set" });
    if (!ethers.isAddress(agent) || tier < 0 || tier > 4) return res.status(400).json({ error: "Bad agent or tier" });
    const wallet = new ethers.Wallet(SIGNER_KEY, provider);
    const badges = new ethers.Contract(ADDR.agentBadges, ["function setBadge(address,uint8,string)"], wallet);
    const tx = await badges.setBadge(agent, tier, note || "");
    await tx.wait();
    res.json({ txHash: tx.hash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/verify", async (req, res) => {
  try {
    requireAddresses(["taskRegistry", "verifierBridge"]);
    if (!SIGNER_KEY) return res.status(500).json({ error: "VERIFIER_SIGNER_KEY not set" });

    const { taskId } = req.body ?? {};
    if (!taskId) return res.status(400).json({ error: "taskId required" });
    const key = taskId.toLowerCase();

    // Cheap cooldown before touching the (paid) LLM call or the RPC — repeated
    // calls for the same task within the window are rejected outright, so a
    // spammer can't cheaply burn LLM budget / RPC quota on one taskId.
    const lastAttempt = verifyCooldown.get(key) || 0;
    if (Date.now() - lastAttempt < VERIFY_COOLDOWN_MS) {
      return res.status(429).json({ error: "Verification already in progress for this task — try again shortly" });
    }
    verifyCooldown.set(key, Date.now());

    const wallet = new ethers.Wallet(SIGNER_KEY, provider);
    const bridge = new ethers.Contract(ADDR.verifierBridge, ABI.verifierBridge, wallet);
    // Check "already settled" first — a cheap on-chain read — before doing any
    // LLM scoring or metadata lookup, so a settled task can never be re-scored.
    const already = await bridge.processed(taskId);
    if (already) return res.json({ status: "settled", note: "already settled onchain" });

    const meta = await readTaskMeta(taskId); // cached after first read (chain.js)
    if (!meta) return res.status(404).json({ error: "Task not found on-chain" });

    const store = loadStore();
    const entry = store[key];
    if (!entry?.deliverable) return res.status(400).json({ error: "No deliverable submitted for this task" });

    const agent = (await readAssignedAgent(taskId)) || entry.agentWallet;
    if (!agent) return res.status(400).json({ error: "Task has no assigned agent" });

    // GenLayer validators independently judge the work. We wait for FINALIZED,
    // not merely ACCEPTED, so an appeal cannot invalidate an Arc payout.
    const verdict = await adjudicateTask({
      sourceId: taskId,
      requester: meta.requester,
      agent,
      title: meta.title,
      description: meta.description,
      rubric: meta.rubric,
      deliverable: entry.deliverable,
    });
    entry.genlayerTxHash = verdict.genlayerTxHash || entry.genlayerTxHash;
    entry.genLayerDecisionId = verdict.adjudicationId;
    entry.genlayerEvidenceHash = verdict.evidenceHash;
    store[key] = entry;
    saveStore(store);

    const settle = async () => {
      const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes(entry.deliverable));
      // Must match VerifierBridge.submitVerification's digest exactly: binds
      // chain + contract instance + agent/requester (not just score/hash) —
      // see docs/AUDIT_REPORT.md, Security #1.
      const inner = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32", "bytes32"],
        [CHAIN_ID, ADDR.verifierBridge, taskId, agent, meta.requester, verdict.passed, verdict.score, deliverableHash, verdict.adjudicationId],
      );
      const signature = await wallet.signMessage(ethers.getBytes(inner));
      const tx = await bridge.submitVerification(taskId, agent, meta.requester, verdict.passed, verdict.score, deliverableHash, verdict.adjudicationId, signature);
      const receipt = await tx.wait();
      return { deliverableHash, txHash: receipt.hash, genlayerTxHash: entry.genlayerTxHash, genlayerDecisionId: verdict.adjudicationId };
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
    const { userId, userToken, walletId, contractAddress, abiFunctionSignature, abiParameters, callData } = req.body ?? {};
    if (!walletId || !contractAddress || (!abiFunctionSignature && !callData) || (!userId && !userToken)) {
      return res.status(400).json({ error: "walletId, contractAddress, (callData or abiFunctionSignature), and userId or userToken required" });
    }
    try {
      const opts = { abiFunctionSignature, abiParameters, callData };
      const out = userToken
        ? await contractExecutionChallengeByToken(userToken, walletId, contractAddress, opts)
        : await contractExecutionChallenge(userId, walletId, contractAddress, opts);
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
