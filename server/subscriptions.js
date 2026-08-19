import { ethers } from "ethers";
import "dotenv/config";
import fs from "node:fs";
import { getChainCtx } from "./chain.js";
import { DEFAULT_NETWORK, isDeployed, scopedKey } from "./networks.js";
import { createEventIndex } from "./eventIndex.js";
import { openIndexStore } from "./indexStore.js";
import { produceWork, scoreAgentWork } from "./score.js";
import { gatherContext } from "./datafeeds.js";
import { subscriptionDeliveryDigest } from "./digests.js";
import { storePath, networkStorePath } from "./store-path.js";

/**
 * Subscription scheduler (Phase A — recurring tasks).
 *
 * Hybrid model: funds/escrow/release live on-chain in SubscriptionManager; the
 * cadence ("which days/times a delivery is due") is computed here off-chain. Each
 * tick, for every active subscription we work out how many scheduled drops are
 * due, and for any not yet delivered we have the persona agent produce the work,
 * score it, sign the verdict with the verifier key, and call recordDelivery —
 * which releases one perDelivery slice of the escrow asset to the agent on-chain.
 *
 * MULTI-CHAIN: one instance per network, each with its own event index, live-state
 * cache, delivery store keys and signer. The signed digest binds the network's
 * chain id and manager address, so a delivery verdict can't cross chains.
 */

const POLL_MS = Number(process.env.SUB_SCHED_POLL_MS || 60000);
const CACHE_MS = Number(process.env.INDEX_CACHE_MS || "30000");

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/* ── Cadence helpers (chain-agnostic; also used by recurring.js) ───────────── */

/** Parse a cadence string like "mon,wed,fri@09:00" or "mon,wed,fri@09:00,17:00". */
export function parseSchedule(s) {
  if (!s || !s.includes("@")) return { days: [1, 2, 3, 4, 5], times: ["09:00"] };
  const [d, t] = s.split("@");
  const days = d
    .split(",")
    .map((x) => DAYS[x.trim().slice(0, 3).toLowerCase()])
    .filter((x) => x != null);
  const times = t.split(",").map((x) => x.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x));
  return { days: days.length ? days : [1, 2, 3, 4, 5], times: times.length ? times : ["09:00"] };
}

/** Timestamp (ms, UTC) of the next scheduled occurrence strictly after nowMs, or null. */
export function nextDueAt(schedule, createdAtMs, nowMs) {
  const { days, times } = parseSchedule(schedule);
  const from = Math.max(createdAtMs, nowMs);
  const start = new Date(from);
  let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let guard = 0; guard < 400; day += 86400000, guard++) {
    const dt = new Date(day);
    if (!days.includes(dt.getUTCDay())) continue;
    const slots = times
      .map((tm) => {
        const [hh, mm] = tm.split(":").map(Number);
        return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), hh || 0, mm || 0);
      })
      .filter((s) => s > nowMs)
      .sort((a, b) => a - b);
    if (slots.length) return slots[0];
  }
  return null;
}

/** Count scheduled occurrences in (createdAtMs, nowMs], in UTC. */
export function dueCount(schedule, createdAtMs, nowMs) {
  const { days, times } = parseSchedule(schedule);
  const start = new Date(createdAtMs);
  let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  let count = 0;
  for (let guard = 0; day <= nowMs && guard < 400; day += 86400000, guard++) {
    const dt = new Date(day);
    if (!days.includes(dt.getUTCDay())) continue;
    for (const tm of times) {
      const [hh, mm] = tm.split(":").map(Number);
      const slot = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), hh || 0, mm || 0);
      if (slot > createdAtMs && slot <= nowMs) count++;
    }
  }
  return count;
}

/* ── Per-network subscription service ─────────────────────────────────────── */

/** An inert service for a network where SubscriptionManager isn't deployed —
 *  reads return empty instead of throwing, and nothing is scheduled. */
function inertService(networkId, label) {
  return {
    networkId,
    label,
    list: async () => [],
    refresh: () => Promise.resolve([]),
    tick: async () => {},
    readDelivery: () => undefined,
    hasSigner: () => false,
    available: false,
  };
}

function createSubscriptions(networkId) {
  const ctx = getChainCtx(networkId);
  if (!ctx.ADDR.subscriptionManager) return inertService(networkId, ctx.label);
  const reader = ctx.contract("subscriptionManager", "subscriptionManager");
  const decimals = ctx.asset.decimals;

  // Delivery bodies (text + score), keyed by chain so two networks can't collide.
  const STORE = storePath("SUB_DELIVERY_STORE", "sub-deliveries.json");
  let deliveries = loadStore();
  function loadStore() {
    try {
      return JSON.parse(fs.readFileSync(STORE, "utf8"));
    } catch {
      return {};
    }
  }
  function saveStore() {
    try {
      fs.writeFileSync(STORE, JSON.stringify(deliveries));
    } catch {
      /* best-effort */
    }
  }
  const dkey = (subId, index) => scopedKey(networkId, `${subId}#${index}`);
  /** Read a delivery, honouring pre-multi-chain keys on Arc. */
  function readDelivery(subId, index) {
    const scoped = deliveries[dkey(subId, index)];
    if (scoped) return scoped;
    return networkId === DEFAULT_NETWORK ? deliveries[`${subId}#${index}`] : undefined;
  }

  let cache = null;
  let cacheAt = 0;
  let inFlight = null;
  const blockTime = new Map();

  async function timeOf(blockNumber) {
    if (blockTime.has(blockNumber)) return blockTime.get(blockNumber);
    const b = await ctx.provider.getBlock(blockNumber);
    const ms = b ? Number(b.timestamp) * 1000 : Date.now();
    blockTime.set(blockNumber, ms);
    return ms;
  }

  // Durable, incremental index of SubscriptionCreated events + a persisted
  // live-state cache (mirrors recurring.js; see eventIndex.js).
  const subIndex = createEventIndex({
    name: `sub-${networkId}`,
    contract: reader,
    filter: reader.filters.SubscriptionCreated(),
    store: networkStorePath("SUB_INDEX_STORE_" + ctx.chainId, "sub-index.json", {
      chainId: ctx.chainId,
      legacyEnvVar: networkId === DEFAULT_NETWORK ? "SUB_INDEX_STORE" : undefined,
      legacyFilename: networkId === DEFAULT_NETWORK ? "sub-index.json" : undefined,
    }),
    fromBlock: Number(process.env[`SUB_FROM_BLOCK_${ctx.chainId}`] || ctx.fromBlockFor("subscriptionManager")),
    idKey: "subId",
    db: openIndexStore(ctx.chainId),
    key: "subscriptions",
    provider: ctx.provider,
    scanRange: ctx.scanRange,
    decode: (log) => ({
      subId: log.args.subId,
      subscriber: log.args.subscriber,
      agent: log.args.agent,
      perDeliveryUsdc: log.args.perDeliveryUsdc.toString(),
      totalDeliveries: Number(log.args.totalDeliveries),
      title: log.args.title,
      brief: log.args.brief,
      rubric: log.args.rubric,
      taskType: log.args.taskType,
      schedule: log.args.schedule,
    }),
  });

  const LIVE_STORE = networkStorePath("SUB_LIVE_STORE_" + ctx.chainId, "sub-live.json", {
    chainId: ctx.chainId,
    legacyEnvVar: networkId === DEFAULT_NETWORK ? "SUB_LIVE_STORE" : undefined,
    legacyFilename: networkId === DEFAULT_NETWORK ? "sub-live.json" : undefined,
  });
  let live = loadLive();
  function loadLive() {
    try {
      return JSON.parse(fs.readFileSync(LIVE_STORE, "utf8"));
    } catch {
      return {};
    }
  }
  function saveLive() {
    try {
      fs.writeFileSync(LIVE_STORE, JSON.stringify(live));
    } catch {
      /* best-effort */
    }
  }

  function deliveryList(subId, count) {
    const list = [];
    for (let i = 0; i < count; i++) {
      const d = readDelivery(subId, i);
      if (d) list.push({ index: i, score: d.score, atMs: d.atMs, hash: d.hash, preview: (d.text || "").slice(0, 160) });
    }
    return list;
  }

  /** Build the subscription list from the durable event index + a live-state
   *  layer. Only new blocks are scanned; live state is re-read only while a
   *  subscription is still active, so a redeploy or RPC hiccup still serves it. */
  async function scanSubscriptions() {
    const now = Date.now();
    const events = await subIndex.catchUp();
    const out = [];
    for (const e of events) {
      let ls = live[e.subId];
      // Refresh on-chain state only while the subscription is still active.
      if (!ls || ls.active) {
        try {
          const state = await reader.getSubscription(e.subId);
          ls = {
            deliveriesDone: Number(state.deliveriesDone),
            escrowed: state.escrowed.toString(),
            active: state.active,
            createdAtMs: ls?.createdAtMs ?? (await timeOf(e.blockNumber)),
          };
          live[e.subId] = ls;
          saveLive();
        } catch {
          if (!ls) continue; // no cached state and RPC failed → skip this round
        }
      }
      out.push({
        subId: e.subId,
        network: networkId,
        subscriber: e.subscriber,
        agent: e.agent,
        perDeliveryUsdc: Number(ethers.formatUnits(e.perDeliveryUsdc, decimals)),
        totalDeliveries: e.totalDeliveries,
        deliveriesDone: ls.deliveriesDone,
        escrowedUsdc: Number(ethers.formatUnits(ls.escrowed, decimals)),
        active: ls.active,
        title: e.title,
        brief: e.brief,
        rubric: e.rubric,
        taskType: e.taskType,
        schedule: e.schedule,
        createdAtMs: ls.createdAtMs,
        dueNow: Math.min(e.totalDeliveries, dueCount(e.schedule, ls.createdAtMs, now)),
        nextDueMs: ls.deliveriesDone < e.totalDeliveries ? nextDueAt(e.schedule, ls.createdAtMs, now) : null,
        deliveries: deliveryList(e.subId, ls.deliveriesDone),
      });
    }
    return out;
  }

  /** Single-flight refresh: concurrent callers (HTTP + scheduler) share one scan;
   *  a failed scan keeps the last good cache instead of throwing. */
  function refresh() {
    if (!inFlight) {
      inFlight = scanSubscriptions()
        .then((out) => {
          cache = out;
          cacheAt = Date.now();
          return out;
        })
        .catch((e) => {
          console.error(`[subscriptions:${networkId}] scan error:`, e.message);
          return cache ?? [];
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /**
   * Stale-while-revalidate list. The HTTP endpoint must never block on the slow
   * scan, so once we have any cache we return it immediately and refresh in the
   * background; only the very first (cold) call awaits a scan. `force` (scheduler)
   * always gets a single-flighted fresh scan.
   */
  async function list(force = false) {
    const fresh = cache && Date.now() - cacheAt < CACHE_MS;
    if (force) return refresh();
    if (fresh) return cache;
    if (cache) {
      refresh();
      return cache;
    } // stale → serve stale, revalidate in bg
    return refresh(); // cold first hit only
  }

  async function deliverOne(sub, index) {
    const wallet = ctx.signer();
    if (!wallet) return;
    // Ground market/weather/stock/sports deliveries in real public-API data.
    const c = await gatherContext({ title: sub.title, description: sub.brief, taskType: sub.taskType });
    const description = c ? `${sub.brief}\n\n${c}\n\nBase the deliverable on the live data above and cite the actual figures.` : sub.brief;
    const { deliverable: text, gradeableText } = await produceWork({ title: sub.title, description, rubric: sub.rubric });
    const { score, passed } = await scoreAgentWork({
      taskDescription: sub.brief,
      qualityRubric: sub.rubric,
      agentOutput: text,
      gradeableText,
    });
    if (!passed) {
      console.log(`[sub:${networkId} ${sub.subId.slice(0, 10)}] delivery #${index} scored ${score} < 70 — will retry next tick`);
      return;
    }
    const hash = ethers.keccak256(ethers.toUtf8Bytes(text));
    // Must match SubscriptionManager.recordDelivery's digest exactly (chain +
    // contract instance domain separation) — see docs/AUDIT_REPORT.md, Security #5.
    const inner = subscriptionDeliveryDigest(ctx, { subId: sub.subId, index, deliverableHash: hash, score });
    const sig = await wallet.signMessage(ethers.getBytes(inner));
    const writer = ctx.contract("subscriptionManager", "subscriptionManager", wallet);
    const tx = await writer.recordDelivery(sub.subId, index, hash, score, sig);
    await tx.wait();
    deliveries[dkey(sub.subId, index)] = { text, score, hash, network: networkId, atMs: Date.now() };
    saveStore();
    cacheAt = 0; // force the list to refresh
    console.log(
      `[sub:${networkId} ${sub.subId.slice(0, 10)}] delivered #${index} (score ${score}) → released ${sub.perDeliveryUsdc} ${ctx.asset.symbol} to ${sub.agent.slice(0, 8)}`,
    );
  }

  async function tick() {
    try {
      const subs = await list(true);
      for (const sub of subs) {
        if (!sub.active) continue;
        const target = Math.min(sub.totalDeliveries, sub.dueNow);
        // Deliver the next un-delivered due slot (one per tick to keep gas/RPC light).
        if (sub.deliveriesDone < target) {
          await deliverOne(sub, sub.deliveriesDone);
        }
      }
    } catch (e) {
      console.error(`[sub-scheduler:${networkId}] tick error:`, e.message);
    }
  }

  return { networkId, list, refresh, tick, readDelivery, hasSigner: () => Boolean(ctx.signer()), label: ctx.label, available: true };
}

/* ── Registry ─────────────────────────────────────────────────────────────── */

const services = new Map();

function serviceFor(networkId = DEFAULT_NETWORK) {
  const id = networkId || DEFAULT_NETWORK;
  let svc = services.get(id);
  if (!svc) {
    svc = createSubscriptions(id);
    services.set(id, svc);
  }
  return svc;
}

/** Subscriptions on one network. */
export async function listSubscriptions(networkId = DEFAULT_NETWORK, force = false) {
  if (!isDeployed(networkId)) return [];
  return serviceFor(networkId).list(force);
}

export function getDelivery(networkId, subId, index) {
  if (!isDeployed(networkId)) return null;
  return serviceFor(networkId).readDelivery(subId, index) || null;
}

/** Start the scheduler for one network. */
export function startScheduler(networkId = DEFAULT_NETWORK) {
  if (!isDeployed(networkId)) {
    console.log(`[subscriptions] ${networkId} not deployed — scheduler not started for it.`);
    return;
  }
  const svc = serviceFor(networkId);
  if (!svc.available) {
    console.log(`[subscriptions:${networkId}] SubscriptionManager not deployed here — scheduler skipped.`);
    return;
  }
  if (!svc.hasSigner()) {
    console.log(`[subscriptions:${networkId}] no signer key — scheduler disabled (read API still served).`);
    svc.refresh(); // still warm the read cache
    return;
  }
  console.log(`[subscriptions:${networkId}] scheduler on · every ${POLL_MS / 1000}s · ${svc.label}`);
  svc.tick();
  setInterval(() => svc.tick(), POLL_MS).unref();
}
