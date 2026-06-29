import { ethers } from "ethers";
import "dotenv/config";
import fs from "node:fs";
import { provider, ADDR, ABI, USDC_DECIMALS, queryLogsChunked } from "./chain.js";
import { produceWork, scoreAgentWork } from "./score.js";
import { gatherContext } from "./datafeeds.js";

/**
 * Subscription scheduler (Phase A — recurring tasks).
 *
 * Hybrid model: funds/escrow/release live on-chain in SubscriptionManager; the
 * cadence ("which days/times a delivery is due") is computed here off-chain. Each
 * tick, for every active subscription we work out how many scheduled drops are
 * due, and for any not yet delivered we have the persona agent produce the work,
 * score it, sign the verdict with the verifier key, and call recordDelivery —
 * which releases one perDelivery slice of USDC to the agent on-chain.
 */

const SIGNER_KEY = process.env.VERIFIER_SIGNER_KEY;
const POLL_MS = Number(process.env.SUB_SCHED_POLL_MS || 60000);
const STORE = process.env.SUB_DELIVERY_STORE || "./sub-deliveries.json";
const CACHE_MS = Number(process.env.INDEX_CACHE_MS || "30000");

const wallet = SIGNER_KEY ? new ethers.Wallet(SIGNER_KEY, provider) : null;
const writer = new ethers.Contract(ADDR.subscriptionManager, ABI.subscriptionManager, wallet || provider);
const reader = new ethers.Contract(ADDR.subscriptionManager, ABI.subscriptionManager, provider);

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

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

// ── On-chain subscription list (cached) ──────────────────────────────────────
let cache = null;
let cacheAt = 0;
const blockTime = new Map();

async function timeOf(blockNumber) {
  if (blockTime.has(blockNumber)) return blockTime.get(blockNumber);
  const b = await provider.getBlock(blockNumber);
  const ms = b ? Number(b.timestamp) * 1000 : Date.now();
  blockTime.set(blockNumber, ms);
  return ms;
}

/** Build the live subscription list from chain (created events + current state). */
export async function listSubscriptions(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_MS) return cache;
  const created = await queryLogsChunked(reader, reader.filters.SubscriptionCreated());
  const out = [];
  for (const log of created) {
    const a = log.args;
    let state;
    try {
      state = await reader.getSubscription(a.subId);
    } catch {
      continue;
    }
    const createdAtMs = await timeOf(log.blockNumber);
    out.push({
      subId: a.subId,
      subscriber: a.subscriber,
      agent: a.agent,
      perDeliveryUsdc: Number(ethers.formatUnits(a.perDeliveryUsdc, USDC_DECIMALS)),
      totalDeliveries: Number(a.totalDeliveries),
      deliveriesDone: Number(state.deliveriesDone),
      escrowedUsdc: Number(ethers.formatUnits(state.escrowed, USDC_DECIMALS)),
      active: state.active,
      title: a.title,
      brief: a.brief,
      rubric: a.rubric,
      taskType: a.taskType,
      schedule: a.schedule,
      createdAtMs,
      dueNow: Math.min(Number(a.totalDeliveries), dueCount(a.schedule, createdAtMs, now)),
      deliveries: deliveryList(a.subId, Number(state.deliveriesDone)),
    });
  }
  cache = out;
  cacheAt = now;
  return out;
}

function deliveryList(subId, count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const d = deliveries[`${subId}#${i}`];
    if (d) list.push({ index: i, score: d.score, atMs: d.atMs, preview: (d.text || "").slice(0, 160) });
  }
  return list;
}

export function getDelivery(subId, index) {
  return deliveries[`${subId}#${index}`] || null;
}

// ── Scheduler ────────────────────────────────────────────────────────────────
async function deliverOne(sub, index) {
  // Ground market/weather/stock/sports deliveries in real public-API data.
  const ctx = await gatherContext({ title: sub.title, description: sub.brief, taskType: sub.taskType });
  const description = ctx ? `${sub.brief}\n\n${ctx}\n\nBase the deliverable on the live data above and cite the actual figures.` : sub.brief;
  const text = await produceWork({ title: sub.title, description, rubric: sub.rubric });
  const { score, passed } = await scoreAgentWork({
    taskDescription: sub.brief,
    qualityRubric: sub.rubric,
    agentOutput: text,
  });
  if (!passed) {
    console.log(`[sub ${sub.subId.slice(0, 10)}] delivery #${index} scored ${score} < 70 — will retry next tick`);
    return;
  }
  const hash = ethers.keccak256(ethers.toUtf8Bytes(text));
  const inner = ethers.solidityPackedKeccak256(
    ["bytes32", "uint32", "bytes32", "uint8"],
    [sub.subId, index, hash, score],
  );
  const sig = await wallet.signMessage(ethers.getBytes(inner));
  const tx = await writer.recordDelivery(sub.subId, index, hash, score, sig);
  await tx.wait();
  deliveries[`${sub.subId}#${index}`] = { text, score, hash, atMs: Date.now() };
  saveStore();
  cacheAt = 0; // force the list to refresh
  console.log(`[sub ${sub.subId.slice(0, 10)}] delivered #${index} (score ${score}) → released ${sub.perDeliveryUsdc} USDC to ${sub.agent.slice(0, 8)}`);
}

async function tick() {
  try {
    const subs = await listSubscriptions(true);
    for (const sub of subs) {
      if (!sub.active) continue;
      const target = Math.min(sub.totalDeliveries, sub.dueNow);
      // Deliver the next un-delivered due slot (one per tick to keep gas/RPC light).
      if (sub.deliveriesDone < target) {
        await deliverOne(sub, sub.deliveriesDone);
      }
    }
  } catch (e) {
    console.error("sub-scheduler tick error:", e.message);
  }
}

export function startScheduler() {
  if (!wallet) {
    console.log("[subscriptions] VERIFIER_SIGNER_KEY not set — scheduler disabled (read API still served).");
    return;
  }
  console.log(`[subscriptions] scheduler on · manager ${ADDR.subscriptionManager} · every ${POLL_MS / 1000}s`);
  tick();
  setInterval(tick, POLL_MS).unref();
}
