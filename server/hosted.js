import { ethers } from "ethers";
import fs from "node:fs";
import { getChainCtx } from "./chain.js";
import { DEFAULT_NETWORK, getNetwork, isDeployed } from "./networks.js";
import { chat } from "./llm.js";
import { storePath } from "./store-path.js";

/**
 * Hosted persona agents (Phase B).
 *
 * Anyone registers a persona on the site (name, capabilities, system prompt) and
 * Polaris runs it here — no infrastructure for the user. Each persona gets a
 * fresh raw-key wallet generated server-side (kept on a Railway persistent
 * volume); the owner funds its stake to activate it. Once funded, the worker
 * registers it on-chain, then autonomously bids on matching tasks, produces the
 * work with the persona's prompt, and submits for verification.
 *
 * MULTI-CHAIN: a persona belongs to exactly ONE network, recorded at creation.
 * Its wallet, stake, registration and bidding all happen on that network only —
 * a BOT Chain persona can never bid on an Arc task, and vice versa. The stake is
 * denominated in that network's escrow asset (USDC on Arc, USDT on BOT Chain);
 * both are 6 decimals, but the value is read from config rather than assumed.
 */
const STORE = storePath("HOSTED_STORE", "hosted-agents.json");
const API_URL = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const POLL_MS = Number(process.env.HOSTED_POLL_MS || 20000);
/** Native coin held back for gas so a persona that just staked can still pay to
 *  bid and submit — only relevant where stake and gas are the same coin. */
const GAS_RESERVE = ethers.parseEther(process.env.HOSTED_GAS_RESERVE || "0.05");

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

/** Legacy personas (created before multi-chain support) live on Arc. */
const netOf = (persona) => persona.network || DEFAULT_NETWORK;

/** Register a new hosted persona; returns its address + funding instructions. */
export function registerHosted({ name, capabilities, systemPrompt, owner, network = DEFAULT_NETWORK }) {
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
    network,
    chainId: getNetwork(network).chainId,
    address: w.address,
    privKey: w.privateKey,
    status: "awaiting-funding",
    createdAtMs: Date.now(),
    seen: [],
  };
  save(store);
  return { id, address: w.address, network };
}

/** Public list for a network (never exposes private keys). */
export function listHosted(owner, network = DEFAULT_NETWORK) {
  return Object.values(load())
    .filter((p) => netOf(p) === network)
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

/** One polling pass for the personas that belong to `networkId`. */
async function tick(networkId) {
  const store = load();
  const personas = Object.values(store).filter((p) => netOf(p) === networkId);
  if (personas.length === 0) return;

  const ctx = getChainCtx(networkId);
  const native = Boolean(ctx.asset.native);
  // Stake floor: the network's own (native networks set it at deploy time), else
  // the ERC-20 registry's 100-unit constant.
  const stake = ctx.minStakeWei ?? ethers.parseUnits("100", ctx.asset.decimals);
  const stakeLabel = ethers.formatUnits(stake, ctx.asset.decimals);

  let index;
  try {
    const r = await fetch(`${API_URL}/api/index?network=${encodeURIComponent(networkId)}`);
    index = await r.json();
  } catch {
    return;
  }
  const openTasks = (index.tasks || []).filter((t) => t.status === "OPEN" && t.deadlineMs > Date.now());

  for (const persona of personas) {
    const wallet = new ethers.Wallet(persona.privKey, ctx.provider);
    const reg = new ethers.Contract(ctx.ADDR.agentRegistry, ctx.ABI.agentRegistry, wallet);
    const token = native ? null : new ethers.Contract(ctx.ADDR.usdc, ctx.ABI.erc20, wallet);
    const assetBalance = () => (native ? ctx.provider.getBalance(persona.address) : token.balanceOf(persona.address));
    let changed = false;
    try {
      const info = await reg.agents(persona.address);
      // 1) Activate once the owner has funded the stake.
      if (!info.registered) {
        const bal = await assetBalance();
        // Native: the stake and the gas come out of the same balance, so the owner
        // must fund enough for both or the persona would stake and then stall.
        const needed = native ? stake + GAS_RESERVE : stake;
        if (bal < needed) {
          if (persona.status !== "awaiting-funding") {
            persona.status = "awaiting-funding";
            changed = true;
          }
        } else {
          // Gas check before writing: a persona with a funded stake but no gas
          // would loop on failures forever. Surface it as a status instead.
          const gas = await ctx.provider.getBalance(persona.address);
          if (gas <= (native ? stake + GAS_RESERVE : 0n)) {
            if (persona.status !== "awaiting-gas") {
              persona.status = "awaiting-gas";
              changed = true;
              console.log(
                `[hosted:${networkId}] ${persona.name} has stake but no ${ctx.gasSymbol} for gas — fund ${persona.address} with ${ctx.gasSymbol} on ${getNetwork(networkId).label}`,
              );
            }
          } else {
            if (!native) {
              const allow = await token.allowance(persona.address, ctx.ADDR.agentRegistry);
              if (allow < stake) await (await token.approve(ctx.ADDR.agentRegistry, stake)).wait();
            }
            await (
              await reg.register(
                ethers.id(persona.id),
                stake,
                persona.name,
                persona.capabilities.join(","),
                native ? { value: stake } : {},
              )
            ).wait();
            persona.status = "active";
            changed = true;
            console.log(`[hosted:${networkId}] ${persona.name} registered on-chain (${persona.address.slice(0, 8)})`);
          }
        }
      } else if (!info.online) {
        await (await reg.restake(0, native ? { value: 0n } : {})).wait();
      }

      // 2) If active, bid on one matching open task per tick.
      if (info.registered) {
        const bidEngine = new ethers.Contract(ctx.ADDR.bidEngine, ctx.ABI.bidEngine, wallet);
        for (const t of openTasks) {
          if (persona.seen?.includes(t.taskId)) continue;
          if (!wants(persona, t)) continue;
          if (Number(info.reputation) < (t.minReputation || 0)) continue;
          try {
            if (await bidEngine.auctionClosed(t.taskId)) {
              persona.seen.push(t.taskId);
              changed = true;
              continue;
            }
            const bid = ethers.parseUnits(String(+(t.budgetUsdc * 0.9).toFixed(6)), ctx.asset.decimals);
            await (await bidEngine.placeBid(t.taskId, bid, 1800)).wait();
            await (await bidEngine.awardBid(t.taskId)).wait();
            persona.seen = persona.seen || [];
            persona.seen.push(t.taskId);
            changed = true;
            // If we won, do the work now.
            const won = (await ctx.contract("taskRegistry", "taskRegistry").tasks(t.taskId)).assignedAgent;
            if (won?.toLowerCase() === persona.address.toLowerCase()) {
              const deliverable = await produce(persona, t);
              // Sign so the backend can verify this submission really came from
              // the persona's own wallet (server/auth.js), not a third party
              // impersonating it (see docs/AUDIT_REPORT.md, Security #2).
              const signature = await wallet.signMessage(`polaris-deliverable:${t.taskId.toLowerCase()}`);
              await post("/api/deliverable", { taskId: t.taskId, agentWallet: persona.address, deliverable, signature }, networkId);
              await post("/api/verify", { taskId: t.taskId }, networkId);
              console.log(`[hosted:${networkId}] ${persona.name} delivered ${t.taskId.slice(0, 10)}`);
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
      console.error(`[hosted:${networkId}] ${persona.name} tick error:`, e.message);
    }
    // Re-read before writing rather than saving the whole snapshot captured at
    // the top of tick(): a concurrent POST /api/hosted-agent (new registration)
    // during this persona's async work would otherwise be silently dropped when
    // the stale in-memory `store` object gets written back.
    if (changed) {
      const fresh = load();
      fresh[persona.id] = persona;
      save(fresh);
      store[persona.id] = persona;
    }
  }
}

/** POST to our own API, always carrying the network. */
/**
 * Headers for a call to our own API. `x-polaris-internal` is how the runtime's own
 * processes authorise the endpoints that spend money (see server/guard.js): the
 * swarm cannot be asked to sign for /api/verify in every case, and the Circle swarm
 * cannot sign at all.
 */
function internalHeaders() {
  const secret = process.env.INTERNAL_API_SECRET;
  return {
    "Content-Type": "application/json",
    ...(secret ? { "x-polaris-internal": secret } : {}),
  };
}

async function post(path, body, networkId) {
  return fetch(`${API_URL}${path}?network=${encodeURIComponent(networkId)}`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ ...body, network: networkId }),
  });
}

/** Start the persona runtime for one network. */
export function startHostedRuntime(networkId = DEFAULT_NETWORK) {
  if (!isDeployed(networkId)) {
    console.log(`[hosted] ${networkId} not deployed — persona runtime not started for it.`);
    return;
  }
  console.log(`[hosted:${networkId}] persona runtime on · every ${POLL_MS / 1000}s · store ${STORE}`);
  tick(networkId);
  setInterval(() => tick(networkId).catch((e) => console.error(`[hosted:${networkId}] loop:`, e.message)), POLL_MS).unref();
}
