import { ethers } from "ethers";
import "dotenv/config";
import fs from "node:fs";
import { provider, ADDR, ABI, USDC_DECIMALS } from "./chain.js";
import { createEventIndex } from "./eventIndex.js";
import { produceWork, scoreAgentWork } from "./score.js";
import { gatherContext } from "./datafeeds.js";
import { parseSchedule, dueCount, nextDueAt } from "./subscriptions.js";

/**
 * Recurring-market scheduler: closes auctions for OPEN plans (after a bid window)
 * and delivers ACTIVE plans on schedule — each drop produced (grounded in live
 * data), scored, signed, and released on-chain via RecurringMarket.recordDelivery.
 */
const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;
const POLL_MS = Number(process.env.RM_POLL_MS || 60000);
const BID_WINDOW_MS = Number(process.env.RM_BID_WINDOW_MS || 120000);
const STORE = process.env.RM_DELIVERY_STORE || "/data/recurring-deliveries.json";
const CACHE_MS = Number(process.env.INDEX_CACHE_MS || "30000");

const wallet = SIGNER_KEY ? new ethers.Wallet(SIGNER_KEY, provider) : null;
const writer = new ethers.Contract(ADDR.recurringMarket, ABI.recurringMarket, wallet || provider);
const reader = new ethers.Contract(ADDR.recurringMarket, ABI.recurringMarket, provider);
const STATUS = ["NONE", "OPEN", "ACTIVE", "COMPLETE", "CANCELLED"];

let deliveries = load();
function load() { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } }
function save() { try { fs.writeFileSync(STORE, JSON.stringify(deliveries)); } catch { /* best-effort */ } }

let cache = null, cacheAt = 0, inFlight = null;
const blockTime = new Map();
async function timeOf(bn) {
  if (blockTime.has(bn)) return blockTime.get(bn);
  const b = await provider.getBlock(bn);
  const ms = b ? Number(b.timestamp) * 1000 : Date.now();
  blockTime.set(bn, ms);
  return ms;
}

// Durable, incremental index of PlanCreated events (survives redeploys; scans
// only new blocks) + a persisted live-state cache so terminal plans are never
// re-read and a cold boot serves instantly. See eventIndex.js.
const planIndex = createEventIndex({
  name: "rm-plans",
  contract: reader,
  filter: reader.filters.PlanCreated(),
  store: process.env.RM_INDEX_STORE || "/data/rm-index.json",
  fromBlock: Number(process.env.RM_FROM_BLOCK || 49364782), // RecurringMarket deploy block
  idKey: "planId",
  decode: (log) => ({
    planId: log.args.planId,
    requester: log.args.requester,
    perDelivery: log.args.perDelivery.toString(),
    total: Number(log.args.total),
    minReputation: log.args.minReputation.toString(),
    title: log.args.title, brief: log.args.brief, rubric: log.args.rubric,
    taskType: log.args.taskType, schedule: log.args.schedule,
  }),
});
const LIVE_STORE = process.env.RM_LIVE_STORE || "/data/rm-live.json";
let live = loadLive();
function loadLive() { try { return JSON.parse(fs.readFileSync(LIVE_STORE, "utf8")); } catch { return {}; } }
function saveLive() { try { fs.writeFileSync(LIVE_STORE, JSON.stringify(live)); } catch { /* best-effort */ } }

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
            bids.push({ agent: b.agent, amount: Number(ethers.formatUnits(b.price, USDC_DECIMALS)), score: Number(b.score) });
          } catch { /* skip a bad index */ }
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
      requester: e.requester,
      agent: ls.agent,
      perDeliveryUsdc: Number(ethers.formatUnits(e.perDelivery, USDC_DECIMALS)),
      priceUsdc: Number(ethers.formatUnits(ls.price, USDC_DECIMALS)),
      total: e.total,
      done: ls.done,
      escrowedUsdc: Number(ethers.formatUnits(ls.escrowed, USDC_DECIMALS)),
      minReputation: Number(e.minReputation),
      status: ls.status,
      bidCount: ls.bidCount,
      bids: ls.bids || [],
      title: e.title, brief: e.brief, rubric: e.rubric, taskType: e.taskType, schedule: e.schedule,
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
function refreshPlans() {
  if (!inFlight) {
    inFlight = scanPlans()
      .then((out) => { cache = out; cacheAt = Date.now(); return out; })
      .catch((e) => { console.error("[recurring] plan scan error:", e.message); return cache ?? []; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * Stale-while-revalidate list. The HTTP endpoint must never block on the slow
 * scan, so once we have any cache we return it immediately and refresh in the
 * background; only the very first (cold) call awaits a scan. `force` (scheduler)
 * always gets a single-flighted fresh scan.
 */
export async function listPlans(force = false) {
  const fresh = cache && Date.now() - cacheAt < CACHE_MS;
  if (force) return refreshPlans();
  if (fresh) return cache;
  if (cache) { refreshPlans(); return cache; } // stale → serve stale, revalidate in bg
  return refreshPlans(); // cold first hit only
}

// Warm the read cache at boot so the first user request finds it ready.
refreshPlans();
function deliveryList(planId, count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const d = deliveries[`${planId}#${i}`];
    if (d) list.push({ index: i, score: d.score, atMs: d.atMs, hash: d.hash, preview: (d.text || "").slice(0, 160) });
  }
  return list;
}
export function getDelivery(planId, index) { return deliveries[`${planId}#${index}`] || null; }

async function deliverOne(plan, index) {
  const ctx = await gatherContext({ title: plan.title, description: plan.brief, taskType: plan.taskType });
  const description = ctx ? `${plan.brief}\n\n${ctx}\n\nBase the deliverable on the live data above and cite the actual figures.` : plan.brief;
  const text = await produceWork({ title: plan.title, description, rubric: plan.rubric });
  const { score, passed } = await scoreAgentWork({ taskDescription: plan.brief, qualityRubric: plan.rubric, agentOutput: text });
  if (!passed) { console.log(`[recurring ${plan.planId.slice(0, 10)}] #${index} scored ${score} < 70 — retry next tick`); return; }
  const hash = ethers.keccak256(ethers.toUtf8Bytes(text));
  const inner = ethers.solidityPackedKeccak256(["bytes32", "uint32", "bytes32", "uint8"], [plan.planId, index, hash, score]);
  const sig = await wallet.signMessage(ethers.getBytes(inner));
  await (await writer.recordDelivery(plan.planId, index, hash, score, sig)).wait();
  deliveries[`${plan.planId}#${index}`] = { text, score, hash, atMs: Date.now() };
  save();
  cacheAt = 0;
  console.log(`[recurring ${plan.planId.slice(0, 10)}] delivered #${index} (score ${score}) → released ${plan.priceUsdc} USDC`);
}

async function tick() {
  try {
    const plans = await listPlans(true);
    const now = Date.now();
    for (const plan of plans) {
      if (plan.status === "OPEN" && plan.bidCount > 0 && now - plan.createdAtMs > BID_WINDOW_MS) {
        try { await (await writer.award(plan.planId)).wait(); console.log(`[recurring ${plan.planId.slice(0, 10)}] auction awarded`); cacheAt = 0; }
        catch (e) { /* maybe already awarded */ }
      } else if (plan.status === "ACTIVE") {
        const target = Math.min(plan.total, plan.dueNow);
        if (plan.done < target) await deliverOne(plan, plan.done);
      }
    }
  } catch (e) {
    console.error("recurring-market tick error:", e.message);
  }
}

export function startRecurringMarket() {
  if (!wallet) { console.log("[recurring] VERIFIER_SIGNER_KEY not set — scheduler disabled."); return; }
  console.log(`[recurring] market scheduler on · ${ADDR.recurringMarket} · every ${POLL_MS / 1000}s`);
  tick();
  setInterval(tick, POLL_MS).unref();
}
