import { ethers } from "ethers";
import fs from "node:fs";
import { provider, ADDR, ABI, USDC_DECIMALS } from "./chain.js";
import { chat } from "./llm.js";

/**
 * Hosted persona agents (Phase B).
 *
 * Anyone registers a persona on the site (name, capabilities, system prompt) and
 * Polaris runs it here — no infrastructure for the user. Each persona gets a
 * fresh raw-key wallet generated server-side (kept on a Railway persistent
 * volume); the owner funds its 100-USDC stake to activate it. Once funded, the
 * worker registers it on-chain, then autonomously bids on matching tasks,
 * produces the work with the persona's prompt, and submits for verification.
 */
const STORE = process.env.HOSTED_STORE || "./hosted-agents.json";
const API_URL = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const POLL_MS = Number(process.env.HOSTED_POLL_MS || 20000);
const STAKE = 100; // USDC, matches AgentRegistry MIN_STAKE
const usdc = (n) => ethers.parseUnits(String(n), USDC_DECIMALS);

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}
function save(s) {
  try {
    fs.writeFileSync(STORE, JSON.stringify(s));
  } catch (e) {
    console.error("[hosted] save failed:", e.message);
  }
}

/** Register a new hosted persona; returns its address + funding instructions. */
export function registerHosted({ name, capabilities, systemPrompt, owner }) {
  const store = load();
  const w = ethers.Wallet.createRandom();
  const id = ethers.id(`${name}:${w.address}`).slice(0, 18);
  store[id] = {
    id,
    name: String(name).slice(0, 40),
    capabilities: (Array.isArray(capabilities) ? capabilities : String(capabilities).split(","))
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 6),
    systemPrompt: String(systemPrompt || "").slice(0, 2000),
    owner: owner || null,
    address: w.address,
    privKey: w.privateKey,
    status: "awaiting-funding",
    createdAtMs: Date.now(),
    seen: [],
  };
  save(store);
  return { id, address: w.address, stakeUsdc: STAKE };
}

/** Public list (never exposes private keys). */
export function listHosted(owner) {
  return Object.values(load())
    .filter((p) => !owner || (p.owner || "").toLowerCase() === owner.toLowerCase())
    .map(({ privKey, seen, ...pub }) => pub);
}

async function produce(persona, meta) {
  const sys =
    (persona.systemPrompt ? persona.systemPrompt + "\n\n" : "") +
    "You are an autonomous Polaris agent. Produce ONLY the deliverable for the task below — " +
    "no preamble, no meta-commentary. Match the rubric precisely.";
  const user = `TASK: ${meta.title}\n\nDETAILS: ${meta.description}\n\nRUBRIC: ${meta.rubric}`;
  return chat([{ role: "system", content: sys }, { role: "user", content: user }], { maxTokens: 1200 });
}

const wants = (persona, meta) =>
  persona.capabilities.includes("general") ||
  persona.capabilities.includes((meta.taskType || "").toLowerCase());

async function tick() {
  const store = load();
  const personas = Object.values(store);
  if (personas.length === 0) return;

  let index;
  try {
    const r = await fetch(`${API_URL}/api/index`);
    index = await r.json();
  } catch {
    return;
  }
  const openTasks = (index.tasks || []).filter((t) => t.status === "OPEN" && t.deadlineMs > Date.now());

  for (const persona of personas) {
    const wallet = new ethers.Wallet(persona.privKey, provider);
    const reg = new ethers.Contract(ADDR.agentRegistry, ABI.agentRegistry, wallet);
    const token = new ethers.Contract(ADDR.usdc, ABI.erc20, wallet);
    let changed = false;
    try {
      const info = await reg.agents(persona.address);
      // 1) Activate once the owner has funded the stake.
      if (!info.registered) {
        const bal = await token.balanceOf(persona.address);
        if (bal < usdc(STAKE)) {
          if (persona.status !== "awaiting-funding") { persona.status = "awaiting-funding"; changed = true; }
        } else {
          const allow = await token.allowance(persona.address, ADDR.agentRegistry);
          if (allow < usdc(STAKE)) await (await token.approve(ADDR.agentRegistry, usdc(STAKE))).wait();
          await (await reg.register(ethers.id(persona.id), usdc(STAKE), persona.name, persona.capabilities.join(","))).wait();
          persona.status = "active";
          changed = true;
          console.log(`[hosted] ${persona.name} registered on-chain (${persona.address.slice(0, 8)})`);
        }
      } else if (!info.online) {
        await (await reg.restake(0)).wait();
      }

      // 2) If active, bid on one matching open task per tick.
      if (info.registered) {
        const bidEngine = new ethers.Contract(ADDR.bidEngine, ABI.bidEngine, wallet);
        for (const t of openTasks) {
          if (persona.seen?.includes(t.taskId)) continue;
          if (!wants(persona, t)) continue;
          if (Number(info.reputation) < (t.minReputation || 0)) continue;
          try {
            if (await bidEngine.auctionClosed(t.taskId)) { persona.seen.push(t.taskId); changed = true; continue; }
            await (await bidEngine.placeBid(t.taskId, usdc(t.budgetUsdc * 0.9), 1800)).wait();
            await (await bidEngine.awardBid(t.taskId)).wait();
            persona.seen = persona.seen || [];
            persona.seen.push(t.taskId);
            changed = true;
            // If we won, do the work now.
            const won = (await new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider).tasks(t.taskId)).assignedAgent;
            if (won?.toLowerCase() === persona.address.toLowerCase()) {
              const deliverable = await produce(persona, t);
              await fetch(`${API_URL}/api/deliverable`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: t.taskId, agentWallet: persona.address, deliverable }) });
              await fetch(`${API_URL}/api/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: t.taskId }) });
              console.log(`[hosted] ${persona.name} delivered ${t.taskId.slice(0, 10)}`);
            }
            break; // one task per persona per tick
          } catch {
            persona.seen = persona.seen || [];
            persona.seen.push(t.taskId);
            changed = true;
          }
        }
      }
    } catch (e) {
      console.error(`[hosted] ${persona.name} tick error:`, e.message);
    }
    if (changed) { store[persona.id] = persona; save(store); }
  }
}

export function startHostedRuntime() {
  console.log(`[hosted] persona runtime on · every ${POLL_MS / 1000}s · store ${STORE}`);
  tick();
  setInterval(() => tick().catch((e) => console.error("[hosted] loop:", e.message)), POLL_MS).unref();
}
