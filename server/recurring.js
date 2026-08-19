import { ethers } from "ethers";
import "dotenv/config";
import fs from "node:fs";
import { getChainCtx } from "./chain.js";
import { DEFAULT_NETWORK, isDeployed, scopedKey } from "./networks.js";
import { createEventIndex } from "./eventIndex.js";
import { openIndexStore } from "./indexStore.js";
import { produceWork, scoreAgentWork } from "./score.js";
import { gatherContext } from "./datafeeds.js";
import { recurringDeliveryDigest } from "./digests.js";
import { dueCount, nextDueAt } from "./subscriptions.js";
import { storePath, networkStorePath } from "./store-path.js";

/**
 * Recurring-market scheduler: closes auctions for OPEN plans (after a bid window)
 * and delivers ACTIVE plans on schedule — each drop produced (grounded in live
 * data), scored, signed, and released on-chain via RecurringMarket.recordDelivery.
 *
 * MULTI-CHAIN: one instance per network, with its own event index, live-state
 * cache, delivery store keys and signer. The delivery digest binds the network's
 * chain id and market address, so a verdict can't be replayed on another chain.
 */
const POLL_MS = Number(process.env.RM_POLL_MS || 60000);
const BID_WINDOW_MS = Number(process.env.RM_BID_WINDOW_MS || 120000);
const CACHE_MS = Number(process.env.INDEX_CACHE_MS || "30000");
const STATUS = ["NONE", "OPEN", "ACTIVE", "COMPLETE", "CANCELLED"];

/** Inert service for a network without RecurringMarket deployed. */
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

function createRecurring(networkId) {
  const ctx = getChainCtx(networkId);
  if (!ctx.ADDR.recurringMarket) return inertService(networkId, ctx.label);
  const reader = ctx.contract("recurringMarket", "recurringMarket");
  const decimals = ctx.asset.decimals;

  const STORE = storePath("RM_DELIVERY_STORE", "recurring-deliveries.json");
  let deliveries = load();
  function load() {
    try {
      return JSON.parse(fs.readFileSync(STORE, "utf8"));
    } catch {
      return {};
    }
  }
  function save() {
    try {
      fs.writeFileSync(STORE, JSON.stringify(deliveries));
    } catch {
      /* best-effort */
    }
  }
  const dkey = (planId, index) => scopedKey(networkId, `${planId}#${index}`);
  function readDelivery(planId, index) {
    const scoped = deliveries[dkey(planId, index)];
    if (scoped) return scoped;
    return networkId === DEFAULT_NETWORK ? deliveries[`${planId}#${index}`] : undefined;
  }

  let cache = null;
  let cacheAt = 0;
  let inFlight = null;
  const blockTime = new Map();
  async function timeOf(bn) {
    if (blockTime.has(bn)) return blockTime.get(bn);
    const b = await ctx.provider.getBlock(bn);
    const ms = b ? Number(b.timestamp) * 1000 : Date.now();
    blockTime.set(bn, ms);
    return ms;
  }

  // Durable, incremental index of PlanCreated events (survives redeploys; scans
  // only new blocks) + a persisted live-state cache so terminal plans are never
  // re-read and a cold boot serves instantly. See eventIndex.js.
  const planIndex = createEventIndex({
    name: `rm-plans-${networkId}`,
    contract: reader,
    filter: reader.filters.PlanCreated(),
    store: networkStorePath("RM_INDEX_STORE_" + ctx.chainId, "rm-index.json", {
      chainId: ctx.chainId,
      legacyEnvVar: networkId === DEFAULT_NETWORK ? "RM_INDEX_STORE" : undefined,
      legacyFilename: networkId === DEFAULT_NETWORK ? "rm-index.json" : undefined,
    }),
    fromBlock: Number(process.env[`RM_FROM_BLOCK_${ctx.chainId}`] || ctx.fromBlockFor("recurringMarket")),
    idKey: "planId",
    db: openIndexStore(ctx.chainId),
    key: "rm-plans",
    provider: ctx.provider,
    scanRange: ctx.scanRange,
    decode: (log) => ({
      planId: log.args.planId,
      requester: log.args.requester,
      perDelivery: log.args.perDelivery.toString(),
      total: Number(log.args.total),
      minReputation: log.args.minReputation.toString(),
      title: log.args.title,
      brief: log.args.brief,
      rubric: log.args.rubric,
      taskType: log.args.taskType,
      schedule: log.args.schedule,
    }),
  });

  const LIVE_STORE = networkStorePath("RM_LIVE_STORE_" + ctx.chainId, "rm-live.json", {
    chainId: ctx.chainId,
    legacyEnvVar: networkId === DEFAULT_NETWORK ? "RM_LIVE_STORE" : undefined,
    legacyFilename: networkId === DEFAULT_NETWORK ? "rm-live.json" : undefined,
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

  function deliveryList(planId, count) {
    const list = [];
    for (let i = 0; i < count; i++) {
      const d = readDelivery(planId, i);
      if (d) list.push({ index: i, score: d.score, atMs: d.atMs, hash: d.hash, preview: (d.text || "").slice(0, 160) });
    }
    return list;
  }

  /** Build the plan list from the durable event index + a live-state layer. The
   *  event set is persisted and only new blocks are scanned; live state (status,
   *  done, escrow, bids) is re-read only for non-terminal plans and cached, so a
   *  transient RPC failure or a redeploy still serves the last-known state. */
  async function scanPlans() {
    const now = Date.now();
    const events = await planIndex.catchUp();
    const out = [];
    for (const e of events) {
      let ls = live[e.planId];
      // Refresh on-chain state only while the plan can still change (OPEN/ACTIVE).
      if (!ls || !ls.terminal) {
        try {
          const s = await reader.getPlan(e.planId);
          const statusNum = Number(s.status);
          const bidCount = Number(await reader.bidCount(e.planId).catch(() => 0));
          // The agents that bid on this plan (agent, price, score) — shown on the
          // plan detail page like a normal task's bids.
          const bids = [];
          for (let i = 0; i < bidCount; i++) {
            try {
              const b = await reader.bidsOf(e.planId, i);
              bids.push({ agent: b.agent, amount: Number(ethers.formatUnits(b.price, decimals)), score: Number(b.score) });
            } catch {
              /* skip a bad index */
            }
          }
          ls = {
            statusNum,
            status: STATUS[statusNum] || "NONE",
            agent: s.agent === ethers.ZeroAddress ? null : s.agent,
            price: s.price.toString(),
            done: Number(s.done),
            escrowed: s.escrowed.toString(),
            bidCount,
            bids,
            createdAtMs: ls?.createdAtMs ?? (await timeOf(e.blockNumber)),
            terminal: statusNum === 3 || statusNum === 4, // COMPLETE or CANCELLED never change
          };
          live[e.planId] = ls;
          saveLive();
        } catch {
          if (!ls) continue; // no cached state and RPC failed → skip this round
        }
      }
      out.push({
        planId: e.planId,
        network: networkId,
        requester: e.requester,
        agent: ls.agent,
        perDeliveryUsdc: Number(ethers.formatUnits(e.perDelivery, decimals)),
        priceUsdc: Number(ethers.formatUnits(ls.price, decimals)),
        total: e.total,
        done: ls.done,
        escrowedUsdc: Number(ethers.formatUnits(ls.escrowed, decimals)),
        minReputation: Number(e.minReputation),
        status: ls.status,
        bidCount: ls.bidCount,
        bids: ls.bids || [],
        title: e.title,
        brief: e.brief,
        rubric: e.rubric,
        taskType: e.taskType,
        schedule: e.schedule,
        createdAtMs: ls.createdAtMs,
        dueNow: Math.min(e.total, dueCount(e.schedule, ls.createdAtMs, now)),
        nextDueMs: ls.done < e.total && ls.statusNum === 2 ? nextDueAt(e.schedule, ls.createdAtMs, now) : null,
        deliveries: deliveryList(e.planId, ls.done),
      });
    }
    return out;
  }

  /** Single-flight refresh: concurrent callers (HTTP + scheduler) share one scan;
   *  a failed scan keeps the last good cache instead of throwing. */
  function refresh() {
    if (!inFlight) {
      inFlight = scanPlans()
        .then((out) => {
          cache = out;
          cacheAt = Date.now();
          return out;
        })
        .catch((e) => {
          console.error(`[recurring:${networkId}] plan scan error:`, e.message);
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

  async function deliverOne(plan, index) {
    const wallet = ctx.signer();
    if (!wallet) return;
    const c = await gatherContext({ title: plan.title, description: plan.brief, taskType: plan.taskType });
    const description = c
      ? `${plan.brief}\n\n${c}\n\nBase the deliverable on the live data above and cite the actual figures.`
      : plan.brief;
    const { deliverable: text, gradeableText } = await produceWork({ title: plan.title, description, rubric: plan.rubric });
    const { score, passed } = await scoreAgentWork({
      taskDescription: plan.brief,
      qualityRubric: plan.rubric,
      agentOutput: text,
      gradeableText,
    });
    if (!passed) {
      console.log(`[recurring:${networkId} ${plan.planId.slice(0, 10)}] #${index} scored ${score} < 70 — retry next tick`);
      return;
    }
    const hash = ethers.keccak256(ethers.toUtf8Bytes(text));
    // Must match RecurringMarket.recordDelivery's digest exactly (chain +
    // contract instance domain separation) — see docs/AUDIT_REPORT.md, Security #5.
    const inner = recurringDeliveryDigest(ctx, { planId: plan.planId, index, deliverableHash: hash, score });
    const sig = await wallet.signMessage(ethers.getBytes(inner));
    const writer = ctx.contract("recurringMarket", "recurringMarket", wallet);
    await (await writer.recordDelivery(plan.planId, index, hash, score, sig)).wait();
    deliveries[dkey(plan.planId, index)] = { text, score, hash, network: networkId, atMs: Date.now() };
    save();
    cacheAt = 0;
    console.log(
      `[recurring:${networkId} ${plan.planId.slice(0, 10)}] delivered #${index} (score ${score}) → released ${plan.priceUsdc} ${ctx.asset.symbol}`,
    );
  }

  async function tick() {
    try {
      const plans = await list(true);
      const now = Date.now();
      const wallet = ctx.signer();
      for (const plan of plans) {
        if (plan.status === "OPEN" && plan.bidCount > 0 && now - plan.createdAtMs > BID_WINDOW_MS) {
          if (!wallet) continue;
          try {
            const writer = ctx.contract("recurringMarket", "recurringMarket", wallet);
            await (await writer.award(plan.planId)).wait();
            console.log(`[recurring:${networkId} ${plan.planId.slice(0, 10)}] auction awarded`);
            cacheAt = 0;
          } catch {
            /* maybe already awarded */
          }
        } else if (plan.status === "ACTIVE") {
          const target = Math.min(plan.total, plan.dueNow);
          if (plan.done < target) await deliverOne(plan, plan.done);
        }
      }
    } catch (e) {
      console.error(`[recurring-market:${networkId}] tick error:`, e.message);
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
    svc = createRecurring(id);
    services.set(id, svc);
  }
  return svc;
}

export async function listPlans(networkId = DEFAULT_NETWORK, force = false) {
  if (!isDeployed(networkId)) return [];
  return serviceFor(networkId).list(force);
}

export function getDelivery(networkId, planId, index) {
  if (!isDeployed(networkId)) return null;
  return serviceFor(networkId).readDelivery(planId, index) || null;
}

export function startRecurringMarket(networkId = DEFAULT_NETWORK) {
  if (!isDeployed(networkId)) {
    console.log(`[recurring] ${networkId} not deployed — scheduler not started for it.`);
    return;
  }
  const svc = serviceFor(networkId);
  if (!svc.available) {
    console.log(`[recurring:${networkId}] RecurringMarket not deployed here — scheduler skipped.`);
    return;
  }
  if (!svc.hasSigner()) {
    console.log(`[recurring:${networkId}] no signer key — scheduler disabled.`);
    svc.refresh();
    return;
  }
  console.log(`[recurring:${networkId}] market scheduler on · every ${POLL_MS / 1000}s · ${svc.label}`);
  svc.tick();
  setInterval(() => svc.tick(), POLL_MS).unref();
}
