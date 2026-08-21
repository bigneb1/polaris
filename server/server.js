import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fs from "node:fs";
import "dotenv/config";

import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { getChainCtx } from "./chain.js";
import { activeNetworkIds, DEFAULT_NETWORK, getNetwork, isActiveNetwork, isDeployed, networkIdOf, scopedKey, signerKeyFor } from "./networks.js";
import { taskVerdictDigest } from "./digests.js";
import { erc8004Available, publishSettlement } from "./erc8004.js";
import { verifyAgentSignature, timingSafeEqualStr } from "./auth.js";
import { authorizeVerify, isInternal, rateLimit } from "./guard.js";
import { scoreAgentWork } from "./score.js";
import { getIndex } from "./indexer.js";
import { getOverview } from "./overview.js";
import { renderDashboard } from "./dashboardPage.js";
import { listSubscriptions, getDelivery } from "./subscriptions.js";
import { resolveDispute, runJury, listReworks, markReworkDone } from "./disputes.js";
import { registerHosted, listHosted } from "./hosted.js";
import { listPlans, getDelivery as getPlanDelivery } from "./recurring.js";
import { storePath, writeJsonAtomic } from "./store-path.js";
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
 *
 * MULTI-CHAIN: every route takes a `network` (query or body) and resolves its
 * chain context, contract addresses and signer from it. Omitted → Arc, so an
 * older frontend build keeps working unchanged. Off-chain store keys are prefixed
 * with the chain id, because a task id is only unique WITHIN a chain — two
 * networks could otherwise overwrite each other's deliverables.
 */
const PORT = process.env.PORT || 8787;
const STORE = storePath("DELIVERABLE_STORE", "deliverables.json");
const ASSET_STORE = storePath("ASSET_STORE", "assets.json");
const AGENT_META_STORE = storePath("AGENT_META_STORE", "agent-meta.json");
const verifyCooldown = new Map(); // `${chainId}:${taskId}` -> ms of last /api/verify attempt
const VERIFY_COOLDOWN_MS = Number(process.env.VERIFY_COOLDOWN_MS || 10_000);

/**
 * Resolve the network for a request and hand back its chain context.
 * Rejects a network whose contracts aren't deployed rather than falling back to
 * another chain's — silently serving Arc data for a BOT request is precisely the
 * cross-network leak this must not have.
 */
function ctxFor(req, res) {
  const id = networkIdOf(req);
  if (!isDeployed(id)) {
    res.status(400).json({
      error: `${getNetwork(id).label} isn't available yet — Polaris hasn't been deployed to that network.`,
      network: id,
    });
    return null;
  }
  // Each chain runs in its own service (Arc's agents are Circle wallets, BOT
  // Chain's are raw-key/ERC-4337), so a network this process doesn't serve has no
  // index, no swarm and no signer here. Say that plainly instead of returning an
  // empty result that looks like "this chain has no activity".
  if (!isActiveNetwork(id)) {
    res.status(409).json({
      error: `This runtime serves ${activeNetworkIds().join(", ") || "no networks"} — not ${getNetwork(id).label}. Point the app at that network's own runtime.`,
      network: id,
      serves: activeNetworkIds(),
    });
    return null;
  }
  return getChainCtx(id);
}

/**
 * Key an off-chain record by chain + id. Reads also accept the legacy
 * un-prefixed key on Arc, so records written before multi-chain support are
 * still found instead of appearing to vanish.
 */
function keyFor(networkId, id) {
  return scopedKey(networkId, id);
}
function readScoped(store, networkId, id) {
  const scoped = store[keyFor(networkId, id)];
  if (scoped !== undefined) return scoped;
  return networkId === DEFAULT_NETWORK ? store[String(id).toLowerCase()] : undefined;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" })); // allow small base64 images

/**
 * Rate limits on the endpoints that spend money or grow the volume. The runtime's
 * own callers carry the internal secret and are exempt (see server/guard.js), so
 * these bound outside abuse without throttling the swarm.
 */
app.use(
  "/api/verify",
  rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_VERIFY || 10), name: "verification" }),
);
app.use(
  "/api/deliverable",
  rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_DELIVERABLE || 20), name: "deliverable" }),
);
app.use(
  "/api/admin",
  rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_ADMIN || 10), name: "admin" }),
);

/*
 * The rest of the write surface. Three routes were limited and sixteen were not, which left
 * the expensive ones wide open:
 *   - /api/asset accepts base64 images against a 6MB body limit, straight onto the volume;
 *   - /api/hosted-agent GENERATES AND STORES A PRIVATE KEY on every call;
 *   - /api/recurring-dispute and /api/dispute/resolve each spend model credits and gas.
 * None of them needed a flood to hurt: storage exhaustion and metered spend are the two
 * costs an anonymous caller could impose without ever touching the money path.
 */
const WRITE_LIMITS = [
  ["/api/asset", Number(process.env.RATE_LIMIT_ASSET || 20), "asset upload"],
  ["/api/agent-meta", Number(process.env.RATE_LIMIT_AGENT_META || 10), "agent metadata"],
  ["/api/hosted-agent", Number(process.env.RATE_LIMIT_HOSTED || 5), "hosted agent"],
  ["/api/recurring-dispute", Number(process.env.RATE_LIMIT_DISPUTE || 5), "recurring dispute"],
  ["/api/dispute", Number(process.env.RATE_LIMIT_DISPUTE || 5), "dispute"],
  ["/api/rating", Number(process.env.RATE_LIMIT_RATING || 10), "rating"],
  ["/api/flag-agent", Number(process.env.RATE_LIMIT_FLAG || 5), "flag"],
  ["/api/rework-done", Number(process.env.RATE_LIMIT_REWORK || 20), "rework"],
];
for (const [route, max, name] of WRITE_LIMITS) {
  app.use(route, rateLimit({ windowMs: 60_000, max, name }));
}

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
  writeJsonAtomic(ASSET_STORE, obj, { pretty: true });
}

// Simple JSON-file persistence for deliverable blobs (keyed by taskId).
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}
/**
 * Age out old deliverables before writing.
 *
 * The store sits on the Railway volume and had no retention at all, behind an
 * endpoint that accepts 6 MB bodies. Deliverables matter until a task settles and
 * for a while afterwards so a requester can read the work; keeping them forever just
 * fills the disk. The hash is attested on chain regardless, so pruning the blob loses
 * the copy, never the proof.
 */
const DELIVERABLE_RETENTION_MS = Number(process.env.DELIVERABLE_RETENTION_DAYS || 90) * 86_400_000;
const DELIVERABLE_MAX_ENTRIES = Number(process.env.DELIVERABLE_MAX_ENTRIES || 5000);

function pruneStore(obj) {
  const cutoff = Date.now() - DELIVERABLE_RETENTION_MS;
  let entries = Object.entries(obj);
  const before = entries.length;
  entries = entries.filter(([, v]) => !v?.at || v.at >= cutoff);
  if (entries.length > DELIVERABLE_MAX_ENTRIES) {
    // Oldest first, so a burst cannot evict the work someone is about to read.
    entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    entries = entries.slice(0, DELIVERABLE_MAX_ENTRIES);
  }
  if (entries.length !== before) {
    console.log(`[store] pruned ${before - entries.length} deliverable(s) past retention`);
    return Object.fromEntries(entries);
  }
  return obj;
}

function saveStore(obj) {
  writeJsonAtomic(STORE, pruneStore(obj), { pretty: true });
}

/**
 * The runtime's front page: a federated dashboard of every agent, on every supported
 * network, plus the merged activity feed.
 *
 * A bare runtime URL used to 404, which told an operator nothing about whether the
 * swarm was alive. Because each chain gets its own service, no single URL could answer
 * "how is the whole swarm doing?" either; this one federates across peers to do it.
 * Server-rendered and dependency-free, so it still works when the frontend does not.
 */
app.get("/", async (_req, res) => {
  try {
    const overview = await getOverview();
    res.type("html").send(renderDashboard(overview));
  } catch (e) {
    // A dashboard that 500s is worse than useless: it looks like the runtime is down.
    res.status(200).type("html").send(
      renderDashboard({
        generatedAtMs: Date.now(),
        serves: activeNetworkIds(),
        peers: [],
        totals: { networks: 0, networksReachable: 0, agents: 0, online: 0, withIdentity: 0, tasks: 0, settledTasks: 0, openTasks: 0, bids: 0 },
        networks: [{ network: "unknown", label: "Overview unavailable", chainId: null, source: "local", error: e.message }],
        agents: [],
        activity: [],
      }),
    );
  }
});

/** The same aggregate as JSON, for scripts and uptime checks. */
app.get("/api/overview", async (_req, res) => {
  try {
    res.json(await getOverview());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  const id = networkIdOf(req);
  // `serves` is the honest answer to "which chain is this runtime?" — one service
  // per network, so a client can tell it reached the right one.
  res.json({
    ok: true,
    network: id,
    chainId: getNetwork(id).chainId,
    signer: signerAddress(id),
    serves: activeNetworkIds(),
    servesNetwork: isActiveNetwork(id),
  });
});

// Server-side chain index (tasks/agents/bids/activity) so the browser doesn't
// have to make hundreds of eth_getLogs calls against the public RPC. Chain
// stays the source of truth; this is a reliable read cache.
app.get("/api/index", async (req, res) => {
  const id = networkIdOf(req);
  // An undeployed network has no index to serve; say so rather than returning
  // another chain's tasks.
  if (!isDeployed(id)) {
    return res.json({ network: id, tasks: [], agents: [], bids: [], activity: [], notDeployed: true });
  }
  // Deployed, but indexed by a different service: an empty index here would be
  // indistinguishable from a quiet chain, so refuse instead.
  if (!isActiveNetwork(id)) {
    return res.status(409).json({
      error: `This runtime indexes ${activeNetworkIds().join(", ")} — not ${getNetwork(id).label}.`,
      network: id,
      serves: activeNetworkIds(),
    });
  }
  try {
    res.json(await getIndex(id));
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
  assets[keyFor(networkIdOf(req), id)] = dataUri;
  saveAssets(assets);
  res.json({ ok: true });
});

app.get("/api/asset/:id", (req, res) => {
  const a = readScoped(loadAssets(), networkIdOf(req), req.params.id);
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
/*
 * An agent's service endpoint is where Polaris POSTs that agent's work, including the full
 * task brief, with a caller-supplied Authorization header. This route accepted `wallet` from
 * the request body and trusted it, so anyone could repoint any agent at a server they
 * controlled: silent hijacking of the work, exfiltration of every brief, and denial of
 * service for the real agent. The deliverable route directly below already refuses
 * client-asserted identity for exactly this reason; this one did not.
 *
 * Ownership is now proven the same way: a signature over `polaris-agent-meta:{wallet}` from
 * the wallet itself, accepted as ECDSA or ERC-1271 so smart-account agents work too.
 */
app.post("/api/agent-meta", async (req, res) => {
  const { wallet, endpoint, auth, signature } = req.body ?? {};
  if (!wallet || typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint)) {
    return res.status(400).json({ error: "wallet and an http(s) endpoint are required" });
  }
  if (!ethers.isAddress(wallet)) return res.status(400).json({ error: "wallet is not an address" });
  if (endpoint.length > 2048) return res.status(413).json({ error: "endpoint too long" });
  if (typeof auth === "string" && auth.length > 1024) return res.status(413).json({ error: "auth header too long" });

  const networkId = networkIdOf(req);
  // The internal secret covers the runtime's own callers (Circle MPC wallets cannot sign
  // off-chain messages); everyone else must prove they hold the key.
  if (!isInternal(req)) {
    const ok = await verifyAgentSignature(
      `polaris-agent-meta:${String(wallet).toLowerCase()}`,
      signature,
      wallet,
      getChainCtx(networkId).provider,
    );
    if (!ok) {
      return res.status(401).json({
        error: "Sign `polaris-agent-meta:<your wallet, lowercased>` with this agent's wallet to set its endpoint.",
      });
    }
  }

  const store = loadAgentMeta();
  store[keyFor(networkId, wallet)] = { endpoint, auth: typeof auth === "string" ? auth : "", at: Date.now() };
  writeJsonAtomic(AGENT_META_STORE, store);
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
    const ctx = ctxFor(req, res);
    if (!ctx) return;
    const { taskId, agentWallet, deliverable, gradeableText, signature } = req.body ?? {};
    if (!taskId || !deliverable) return res.status(400).json({ error: "taskId and deliverable required" });

    const assignedAgent = await ctx.readAssignedAgent(taskId);
    if (!assignedAgent) return res.status(400).json({ error: "Task has no assigned agent on-chain yet" });
    if (agentWallet && String(agentWallet).toLowerCase() !== assignedAgent.toLowerCase()) {
      return res.status(403).json({ error: "agentWallet is not the on-chain assigned agent for this task" });
    }

    const store = loadStore();
    const key = keyFor(ctx.id, taskId);
    const prev = store[key] || (ctx.id === DEFAULT_NETWORK ? store[taskId.toLowerCase()] : undefined) || {};

    let verified = false;
    if (signature) {
      // The signed message stays the bare task id (that's what the agent signs);
      // only the STORE key is chain-scoped.
      // ctx.provider, not the default: an ERC-4337 agent account on BOT Chain is
      // only verifiable against BOT Chain.
      verified = await verifyAgentSignature(`polaris-deliverable:${taskId.toLowerCase()}`, signature, assignedAgent, ctx.provider);
      if (!verified) return res.status(403).json({ error: "Invalid signature for the assigned agent" });
    } else if (prev.verified) {
      return res.status(403).json({ error: "A verified deliverable already exists; resubmission requires a valid signature" });
    }

    // Preserve attempt history across resubmissions (used by the review flow).
    store[key] = {
      agentWallet: assignedAgent,
      network: ctx.id,
      deliverable,
      // Source text for a rendered file (PDF), so the verifier has something it can
      // actually grade. Without it a binary deliverable is ungradeable, and an
      // ungradeable deliverable is never paid (see server/score.js).
      ...(typeof gradeableText === "string" && gradeableText.trim() ? { gradeableText } : {}),
      at: Date.now(),
      attempts: prev.attempts || 0,
      verified,
    };
    saveStore(store);
    res.json({ ok: true, verified, network: ctx.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reading a deliverable requires proof the caller is the task's on-chain
// requester or its assigned agent — a short-lived signed token (max 15 min),
// not a full re-sign on every fetch. `message = polaris-view:{taskId}:{expiry}`.
app.get("/api/deliverable/:taskId", async (req, res) => {
  try {
    const ctx = ctxFor(req, res);
    if (!ctx) return;
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
    const ok = await verifyAgentSignature(`polaris-view:${taskId.toLowerCase()}:${expiryMs}`, signature, String(viewer), ctx.provider);
    if (!ok) return res.status(403).json({ error: "invalid signature" });

    const [meta, assignedAgent] = await Promise.all([ctx.readTaskMeta(taskId), ctx.readAssignedAgent(taskId)]);
    const v = String(viewer).toLowerCase();
    const isRequester = meta && meta.requester.toLowerCase() === v;
    const isAgent = assignedAgent && assignedAgent.toLowerCase() === v;
    if (!isRequester && !isAgent) return res.status(403).json({ error: "not authorized to view this deliverable" });

    const entry = readScoped(loadStore(), ctx.id, taskId);
    res.json({ deliverable: entry?.deliverable ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recurring tasks / subscriptions (Phase A) ────────────────────────────────
app.get("/api/subscriptions", async (req, res) => {
  const id = networkIdOf(req);
  if (!isDeployed(id)) return res.json({ network: id, subscriptions: [], notDeployed: true });
  try {
    res.json({ network: id, subscriptions: await listSubscriptions(id) });
  } catch (e) {
    res.status(500).json({ error: e.message, subscriptions: [] });
  }
});

app.get("/api/sub-deliverable/:subId/:index", (req, res) => {
  const d = getDelivery(networkIdOf(req), req.params.subId, Number(req.params.index));
  res.json({ deliverable: d?.text ?? null, score: d?.score ?? null });
});

// ── Recurring market (auctioned recurring plans) ─────────────────────────────
app.get("/api/recurring-plans", async (req, res) => {
  const id = networkIdOf(req);
  if (!isDeployed(id)) return res.json({ network: id, plans: [], notDeployed: true });
  try {
    res.json({ network: id, plans: await listPlans(id) });
  } catch (e) {
    res.status(500).json({ error: e.message, plans: [] });
  }
});
app.get("/api/recurring-deliverable/:planId/:index", (req, res) => {
  const d = getPlanDelivery(networkIdOf(req), req.params.planId, Number(req.params.index));
  res.json({ deliverable: d?.text ?? null, score: d?.score ?? null });
});

// Per-delivery dispute on a recurring plan: the AI jury re-judges THIS delivery's
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
    const networkId = networkIdOf(req);
    const { planId, index, complaint, reporter } = req.body || {};
    if (!planId || index == null) return res.status(400).json({ error: "planId + index required" });
    const d = getPlanDelivery(networkId, planId, Number(index));
    if (!d?.text) return res.status(404).json({ error: "No deliverable found for that delivery yet." });
    const plan = (await listPlans(networkId)).find((p) => p.planId.toLowerCase() === String(planId).toLowerCase());
    if (!plan) return res.status(404).json({ error: "Plan not found." });
    const { upheld, juryNote } = await runJury({
      title: plan.title,
      description: plan.brief,
      rubric: plan.rubric,
      deliverable: d.text,
      complaint: complaint || "(no written complaint provided)",
    });
    const store = loadRDisputes();
    store[keyFor(networkId, `${planId}#${index}`)] = { planId, network: networkId, index: Number(index), complaint: (complaint || "").slice(0, 500), upheld, juryNote, reporter: reporter || null, atMs: Date.now() };
    try {
      writeJsonAtomic(RD_DISPUTE_STORE, store);
    } catch {
      /* best-effort */
    }
    res.json({ upheld, juryNote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/recurring-disputes/:planId", (req, res) => {
  const networkId = networkIdOf(req);
  const store = loadRDisputes();
  const pid = String(req.params.planId).toLowerCase();
  const out = {};
  for (const v of Object.values(store)) {
    // Legacy records (written before multi-chain) carry no network and belong to Arc.
    const recNet = v.network || DEFAULT_NETWORK;
    if (recNet === networkId && String(v.planId).toLowerCase() === pid) out[v.index] = v;
  }
  res.json({ disputes: out });
});

// ── Hosted persona agents (Phase B) ──────────────────────────────────────────
app.post("/api/hosted-agent", (req, res) => {
  try {
    const ctx = ctxFor(req, res);
    if (!ctx) return;
    const { name, capabilities, systemPrompt, owner } = req.body || {};
    if (!name || !capabilities) return res.status(400).json({ error: "name + capabilities required" });
    // The stake is denominated in the network's escrow asset (USDC on Arc, native BOT on
    // BOT Chain), so the response says which rather than letting the UI assume.
    // The stake floor differs per network (native networks set it at deploy time,
    // ERC-20 ones use the registry's 100-unit constant), so report it rather than
    // letting the UI assume 100.
    const stakeAmount = ctx.minStakeWei
      ? Number(ethers.formatUnits(ctx.minStakeWei, ctx.asset.decimals))
      : 100;
    res.json({
      ...registerHosted({ name, capabilities, systemPrompt, owner, network: ctx.id }),
      stakeAmount,
      stakeSymbol: ctx.asset.symbol,
      gasSymbol: ctx.gasSymbol,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/hosted-agents", (req, res) => {
  const id = networkIdOf(req);
  res.json({ network: id, agents: listHosted(req.query.owner, id) });
});

// ── Disputes + AI jury (Phase C) ─────────────────────────────────────────────
// After the requester opens a dispute on-chain, this runs the jury and settles it.
app.post("/api/dispute/resolve", async (req, res) => {
  try {
    const ctx = ctxFor(req, res);
    if (!ctx) return;
    const { disputeId, reason } = req.body || {};
    if (!disputeId) return res.status(400).json({ error: "disputeId required" });
    const result = await resolveDispute(ctx.id, disputeId, reason || "");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rework queue — an upheld dispute asks the assigned agent to redo the work.
// The swarm polls this and re-produces the deliverable, then marks it done.
app.get("/api/reworks", (req, res) => res.json({ reworks: listReworks(networkIdOf(req)) }));
app.post("/api/rework-done", (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "taskId required" });
  markReworkDone(networkIdOf(req), taskId);
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
    const ctx = ctxFor(req, res);
    if (!ctx) return;
    const { agent, taskId, rater, stars, comment } = req.body || {};
    if (!agent || !taskId || !rater || !(stars >= 1 && stars <= 5)) {
      return res.status(400).json({ error: "agent + taskId + rater + stars(1-5) required" });
    }
    // Proof of engagement is read from the SAME network the rating is filed on.
    const reg = ctx.contract("taskRegistry", "taskRegistry");
    const t = await reg.tasks(taskId);
    if (Number(t.status) !== TASK_STATUS_SETTLED) return res.status(403).json({ error: "Task is not settled yet" });
    if (t.requester.toLowerCase() !== String(rater).toLowerCase())
      return res.status(403).json({ error: "Only the task's requester can rate it" });
    if (t.assignedAgent.toLowerCase() !== String(agent).toLowerCase())
      return res.status(403).json({ error: "agent does not match the task's assigned agent" });

    // Proof of engagement is not proof of identity. Every field checked above is public
    // chain data, so anyone could file a rating "as" the requester: five-star your own
    // agent, one-star a competitor. The rater must prove they hold the key.
    if (!isInternal(req)) {
      const ok = await verifyAgentSignature(
        `polaris-rating:${String(taskId).toLowerCase()}`,
        req.body?.signature,
        rater,
        ctx.provider,
      );
      if (!ok) {
        return res.status(401).json({
          error: "Sign `polaris-rating:<taskId, lowercased>` with the requester's wallet to rate this task.",
        });
      }
    }

    const store = loadRatings();
    const key = keyFor(ctx.id, agent);
    store[key] = store[key] || [];
    // One rating per (task, rater); replace if it exists.
    store[key] = store[key].filter((r) => !(r.taskId === taskId && r.rater === rater));
    store[key].push({ taskId, network: ctx.id, rater, stars: Number(stars), comment: (comment || "").slice(0, 500), atMs: Date.now() });
    try {
      writeJsonAtomic(RATINGS_STORE, store);
    } catch {
      /* best-effort */
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/ratings/:agent", (req, res) => {
  const list = readScoped(loadRatings(), networkIdOf(req), req.params.agent) || [];
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
app.post("/api/flag-agent", async (req, res) => {
  const networkId = networkIdOf(req);
  const { agent, reporter, reason, signature } = req.body || {};
  if (!ethers.isAddress(agent) || !(reason || "").trim())
    return res.status(400).json({ error: "valid agent address + reason required" });

  // A flag may be anonymous, but it may not be attributed to someone who did not file it.
  // `reporter` was stored verbatim, so anyone could file complaints in a stranger's name and
  // the operator queue would show them as that person's.
  let claimedReporter = null;
  if (reporter) {
    if (!ethers.isAddress(reporter)) return res.status(400).json({ error: "reporter is not an address" });
    const ok =
      isInternal(req) ||
      (await verifyAgentSignature(
        `polaris-flag:${String(agent).toLowerCase()}`,
        signature,
        reporter,
        getChainCtx(networkId).provider,
      ));
    if (!ok) {
      return res.status(401).json({
        error: "Sign `polaris-flag:<agent address, lowercased>` to file this under your wallet, or omit `reporter` to flag anonymously.",
      });
    }
    claimedReporter = reporter;
  }
  const store = loadFlags();
  const key = keyFor(networkId, agent);
  store[key] = store[key] || [];
  // One open flag per (agent, reporter): replace an earlier pending one.
  store[key] = store[key].filter((f) => !(claimedReporter && f.reporter === claimedReporter && f.status === "pending"));
  store[key].push({
    reporter: claimedReporter,
    network: networkId,
    reason: String(reason).slice(0, 1000),
    status: "pending",
    atMs: Date.now(),
  });
  try {
    writeJsonAtomic(FLAGS_STORE, store);
  } catch {
    /* best-effort */
  }
  res.json({ ok: true, count: store[key].length });
});
// Public: how many open flags an agent has (surface a "under review" hint).
app.get("/api/flags/:agent", (req, res) => {
  const list = readScoped(loadFlags(), networkIdOf(req), req.params.agent) || [];
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
    const ctx = ctxFor(req, res);
    if (!ctx) return;
    const { secret, agent, tier, note } = req.body || {};
    if (!process.env.ADMIN_SECRET || !timingSafeEqualStr(secret || "", process.env.ADMIN_SECRET))
      return res.status(403).json({ error: "Forbidden" });
    const wallet = ctx.signer();
    if (!wallet) return res.status(500).json({ error: `No verifier signer key configured for ${ctx.label}` });
    if (!ethers.isAddress(agent) || tier < 0 || tier > 4) return res.status(400).json({ error: "Bad agent or tier" });
    if (!ctx.ADDR.agentBadges) return res.status(400).json({ error: `AgentBadges isn't deployed on ${ctx.label}` });
    const badges = new ethers.Contract(ctx.ADDR.agentBadges, ["function setBadge(address,uint8,string)"], wallet);
    const tx = await badges.setBadge(agent, tier, note || "");
    await tx.wait();
    res.json({ txHash: tx.hash, network: ctx.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/verify", async (req, res) => {
  try {
    const ctx = ctxFor(req, res);
    if (!ctx) return;
    ctx.requireAddresses(["taskRegistry", "verifierBridge"]);
    const wallet = ctx.signer();
    if (!wallet) {
      return res.status(500).json({ error: `No verifier signer key configured for ${ctx.label}` });
    }

    const { taskId } = req.body ?? {};
    if (!taskId) return res.status(400).json({ error: "taskId required" });

    // Cheap bail BEFORE any chain read. A request carrying neither the internal
    // secret nor a signature can never be authorised, so refusing it here means an
    // anonymous caller cannot make us do RPC work either, and cannot use the 404 to
    // probe which task ids exist. The full check needs `agent`/`requester`, so it
    // still happens below once those are read.
    if (!isInternal(req) && !req.body?.signature) {
      return res.status(401).json({
        error:
          "Verification requires authorisation: sign `polaris-verify:<taskId>` as the assigned agent or the task's requester.",
        network: ctx.id,
      });
    }
    // Cooldown and store keys are chain-scoped: the same task id could exist on
    // two networks and must not share a cooldown or a deliverable.
    const key = keyFor(ctx.id, taskId);

    // Cheap cooldown before touching the (paid) LLM call or the RPC — repeated
    // calls for the same task within the window are rejected outright, so a
    // spammer can't cheaply burn LLM budget / RPC quota on one taskId.
    const lastAttempt = verifyCooldown.get(key) || 0;
    if (Date.now() - lastAttempt < VERIFY_COOLDOWN_MS) {
      return res.status(429).json({ error: "Verification already in progress for this task — try again shortly" });
    }
    verifyCooldown.set(key, Date.now());

    const bridge = ctx.contract("verifierBridge", "verifierBridge", wallet);
    // Check "already settled" first — a cheap on-chain read — before doing any
    // LLM scoring or metadata lookup, so a settled task can never be re-scored.
    const already = await bridge.processed(taskId);
    if (already) return res.json({ status: "settled", note: "already settled onchain" });

    const meta = await ctx.readTaskMeta(taskId); // cached per network after first read
    if (!meta) return res.status(404).json({ error: `Task not found on ${ctx.label}` });

    const store = loadStore();
    const entry = readScoped(store, ctx.id, taskId);
    if (!entry?.deliverable) return res.status(400).json({ error: "No deliverable submitted for this task" });

    const agent = (await ctx.readAssignedAgent(taskId)) || entry.agentWallet;
    if (!agent) return res.status(400).json({ error: "Task has no assigned agent" });

    // Authorise BEFORE spending anything. Scoring costs model credits and settling
    // costs gas from the verifier key, so this check has to come ahead of both, and
    // after `agent`/`requester` are known because they are what a caller signs as.
    // See server/guard.js for why an internal secret and a signature are both needed.
    const auth = await authorizeVerify(req, ctx, { taskId, agent, requester: meta.requester });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error, network: ctx.id });
    }

    // 1. Score with our algorithm
    const verdict = await scoreAgentWork({
      taskDescription: `${meta.title}\n\n${meta.description}`,
      qualityRubric: meta.rubric,
      agentOutput: entry.deliverable,
      // Present only for a rendered file: the source text to judge, while the file
      // itself remains what is hashed and attested on chain.
      gradeableText: entry.gradeableText,
    });

    const settle = async () => {
      const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes(entry.deliverable));
      // Must match VerifierBridge.submitVerification's digest exactly: binds
      // chain + contract instance + agent/requester (not just score/hash) —
      // see docs/AUDIT_REPORT.md, Security #1.
      // Binds THIS chain and THIS bridge instance, so a verdict signed for one
      // network can never settle on another (the digest wouldn't recover).
      // Digest shape follows the DEPLOYED VerifierBridge, not the repo's — Arc's
      // instance predates the hardened one. See server/digests.js.
      const inner = taskVerdictDigest(ctx, {
        taskId,
        agent,
        requester: meta.requester,
        passed: verdict.passed,
        score: verdict.score,
        deliverableHash,
      });
      const signature = await wallet.signMessage(ethers.getBytes(inner));
      const tx = await bridge.submitVerification(taskId, agent, meta.requester, verdict.passed, verdict.score, deliverableHash, signature);
      const receipt = await tx.wait();
      return { deliverableHash, txHash: receipt.hash };
    };

    // ── PASS: release the escrow + record attestations ──────────────────────
    if (verdict.passed) {
      const out = await settle();
      // Publish the same verdict to ERC-8004 (validation + reputation) where those
      // registries exist. Deliberately AFTER settlement and deliberately
      // best-effort: the money has already moved through VerifierBridge, so a
      // registry hiccup must not turn a paid task into a failed request.
      let erc8004 = null;
      if (erc8004Available(ctx)) {
        erc8004 = await publishSettlement(ctx, wallet, {
          agentWallet: agent,
          score: verdict.score,
          deliverableHash: out.deliverableHash,
          taskId,
          endpoint: loadAgentMeta()[String(agent).toLowerCase()]?.endpoint,
        });
      }
      return res.json({ ...verdict, status: "released", network: ctx.id, ...out, erc8004 });
    }

    // ── FAIL: reject-with-feedback first; slash only on a late, final failure ─
    // Rules: a submission that fails is REJECTED (not slashed) and the agent gets
    // feedback to retry, capped at MAX_ATTEMPTS. The agent is only SLASHED if it
    // has used all attempts AND burned more than SLASH_TIME_FRACTION of the task
    // window — so quick early failures cost nothing but stake-risk grows late.
    const MAX_ATTEMPTS = Number(process.env.MAX_REVIEW_ATTEMPTS || 3);
    const SLASH_TIME_FRACTION = Number(process.env.SLASH_TIME_FRACTION || 0.5);

    // Attempts are PER AGENT, not per task. They used to be a single counter on the
    // task, so when a rejected task was reopened the next agent inherited a counter
    // the previous one had already spent — it could arrive with zero attempts left,
    // having done nothing wrong. Keeping the old total alongside means an existing
    // store keeps working and the task-wide history is not lost.
    entry.attemptsByAgent = entry.attemptsByAgent || {};
    const agentKey = String(agent).toLowerCase();
    const attempts = (entry.attemptsByAgent[agentKey] ?? entry.attempts ?? 0) + 1;
    entry.attemptsByAgent[agentKey] = attempts;
    entry.attempts = (entry.attempts || 0) + 1; // task-wide total, for the record
    entry.lastReason = verdict.reasoning;
    entry.network = ctx.id;
    store[key] = entry;
    saveStore(store);

    // Elapsed fraction of the task window (createdAt..deadline), read on-chain.
    let elapsedFraction = 1;
    try {
      const t = await ctx.contract("taskRegistry", "taskRegistry").tasks(taskId);
      const createdMs = Number(t.createdAt) * 1000;
      const total = meta.deadline - createdMs;
      if (total > 0) elapsedFraction = (Date.now() - createdMs) / total;
    } catch {
      /* fall back to slash-eligible if timing unreadable */
    }

    // An UNGRADEABLE deliverable is our failure, not the agent's: it means the
    // grader could not read the work (no vision model configured, a binary file with
    // no source text). Rejecting it is right, slashing the agent's stake for it is
    // not, so ungradeable results never become slash-eligible however many attempts
    // they burn.
    const slashEligible =
      !verdict.ungradeable && attempts >= MAX_ATTEMPTS && elapsedFraction > SLASH_TIME_FRACTION;
    if (verdict.ungradeable) {
      console.warn(
        `[verify:${ctx.id}] task ${String(taskId).slice(0, 10)} could not be graded: ${verdict.reasoning}`,
      );
    }
    if (slashEligible) {
      const out = await settle(); // passed=false → escrow refund to requester + stake slash
      return res.json({ ...verdict, status: "slashed", network: ctx.id, attempts, elapsedFraction, ...out });
    }

    // Rejected: return the task to the market (reopen) so any agent can re-bid,
    // unless the deadline has passed (then leave it for slashOnTimeout). USDC
    // stays escrowed; the agent is NOT slashed.
    // Always reopen a task that was not slashed. An agent out of attempts is done
    // with THIS task, but the task itself is not done: it goes back on the market so
    // another agent can take it with a fresh budget of attempts, which is the whole
    // point of not slashing an early failure. Leaving it ASSIGNED instead is how a
    // decided task ends up reading "in progress" for hours — the exact stuck state
    // this system is supposed to make impossible. The failing agent does not simply
    // re-win it: the swarm excludes any agent that already produced work for it.
    let reopened = false;
    let reopenError = null;
    if (meta.deadline > Date.now()) {
      // `reopenTask` is `onlyAuthorized` — it checks msg.sender against
      // bidEngine/verifierBridge/owner. The per-network VERDICT signer is none of
      // those: it only has to produce a signature VerifierBridge can recover, and
      // whoever sends `submitVerification` is irrelevant. Sending the reopen from
      // it reverted with "Not authorized" on every rejected task, which silently
      // pinned them in ASSIGNED until the deadline. Use the registry owner.
      const owner = ctx.ownerSigner() ?? wallet;
      try {
        const tr = ctx.contract("taskRegistry", "taskRegistry", owner);
        const tx = await tr.reopenTask(taskId);
        await tx.wait();
        reopened = true;
      } catch (e) {
        reopenError = e.shortMessage || e.message;
        // Loud, and actionable: a task that cannot be reopened is a task stuck in
        // ASSIGNED, and the operator needs to know which key is missing to fix it.
        console.error(
          `[verify:${ctx.id}] reopenTask failed for ${String(taskId).slice(0, 10)} as ${owner.address}: ${reopenError}. ` +
            `The task stays ASSIGNED until its deadline. reopenTask is onlyAuthorized — set REGISTRY_OWNER_KEY ` +
            `(or VERIFIER_SIGNER_KEY) on this service to the TaskRegistry owner.`,
        );
      }
    }
    return res.json({
      ...verdict,
      status: "rejected",
      reopenError,
      network: ctx.id,
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

/** Verifier signer address for a network (each may use its own key). */
function signerAddress(networkId = DEFAULT_NETWORK) {
  try {
    const key = signerKeyFor(networkId);
    return key ? new ethers.Wallet(key).address : null;
  } catch {
    return null;
  }
}

// ── x402 nanopayment sub-service (Circle Gateway on Arc) ─────────────────────
// A paywalled "price oracle" an agent pays $0.01 USDC to call — demonstrates
// agent-to-agent nanopayments settled via Circle Gateway and batched on Arc
// (the literal Lepton thesis), running alongside the escrow-based task economy.
// Arc only: x402 settles through Circle Gateway, and BOT Chain has no Circle
// presence (and no USDC) for a facilitator to work with. Guarded rather than
// faked — see the compatibility report.
const X402_NETWORK_ID = DEFAULT_NETWORK;
const X402_SELLER = getNetwork(X402_NETWORK_ID).supportsX402
  ? process.env.X402_SELLER || signerAddress(X402_NETWORK_ID)
  : null;
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
        network: X402_NETWORK_ID,
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
  for (const id of activeNetworkIds()) {
    const n = getNetwork(id);
    console.log(`  ↳ ${n.label} (${id}) chain ${n.chainId} · ${n.asset.symbol} · signer ${signerAddress(id) ?? "(unset)"}`);
  }
});
