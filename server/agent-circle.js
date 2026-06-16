import { ethers } from "ethers";
import "dotenv/config";

import { ADDR, ABI, provider, readTaskMeta, USDC_DECIMALS, requireAddresses } from "./chain.js";
import { produceWork } from "./score.js";
import { listAgentWallets, fundWallet, execute, isLoggedIn, CIRCLE_CHAIN } from "./circle-wallet.js";

/**
 * Polaris autonomous swarm — Circle agent-wallet edition.
 *
 * Identical lifecycle to agent.js (poll → decide → bid → win → work → settle),
 * but every on-chain WRITE is executed from a Circle MPC agent wallet via the
 * Circle CLI — no raw private keys. View reads use the public RPC.
 *
 * Operator setup (once):
 *   export CIRCLE_ACCEPT_TERMS=1
 *   circle wallet login <email> --type agent        # provisions Arc agent wallets
 *   circle wallet list --chain ARC-TESTNET --type agent   # copy the addresses
 * Then set AGENTS_CIRCLE_JSON in .env (persona → wallet address) and run:
 *   npm run swarm:circle
 */
const API_URL = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const POLL_MS = Number(process.env.SWARM_POLL_MS || 12000);
const LOOKBACK = Number(process.env.INDEX_LOOKBACK_BLOCKS || "500000");
const SETTLE_WAIT_MS = Number(process.env.CIRCLE_SETTLE_WAIT_MS || 8000);
const usdc = (n) => ethers.parseUnits(String(n), USDC_DECIMALS);

/** @type {{name:string,address:string,capabilities:string[],stake:number,markup:number}[]} */
const AGENTS = JSON.parse(process.env.AGENTS_CIRCLE_JSON || "[]");

function agentId(name, wallet) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${name.toLowerCase()}:${wallet.toLowerCase()}`));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read-only contract handles (writes go through Circle).
const reg = new ethers.Contract(ADDR.agentRegistry, ABI.agentRegistry, provider);
const bidR = new ethers.Contract(ADDR.bidEngine, ABI.bidEngine, provider);
const usdcR = new ethers.Contract(ADDR.usdc, ABI.erc20, provider);
const taskReg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);

class CircleAgent {
  constructor(cfg) {
    this.cfg = cfg;
    this.address = ethers.getAddress(cfg.address);
    this.seen = new Set();
    this.handled = new Set();
  }
  log(...a) {
    console.log(`[${this.cfg.name} ${this.address.slice(0, 8)}]`, ...a);
  }

  async ensureRegistered() {
    const info = await reg.agents(this.address);
    if (info.registered) {
      if (!info.online) {
        await execute(this.address, ADDR.agentRegistry, "restake(uint256)", [0]);
        this.log("back online");
      }
      return;
    }
    const stakeAmt = usdc(this.cfg.stake ?? 5);
    // ensure the wallet has USDC (faucet) + allowance to the registry
    const bal = await usdcR.balanceOf(this.address);
    if (bal < stakeAmt) {
      this.log("funding from Circle faucet…");
      try {
        await fundWallet(this.address);
        await sleep(SETTLE_WAIT_MS);
      } catch (e) {
        this.log("faucet:", e.message);
      }
    }
    const allowance = await usdcR.allowance(this.address, ADDR.agentRegistry);
    if (allowance < stakeAmt) {
      await execute(this.address, ADDR.usdc, "approve(address,uint256)", [ADDR.agentRegistry, stakeAmt]);
      await sleep(SETTLE_WAIT_MS);
    }
    await execute(this.address, ADDR.agentRegistry, "register(bytes32,uint256,string,string)", [
      agentId(this.cfg.name, this.address),
      stakeAmt,
      this.cfg.name,
      (this.cfg.capabilities || []).join(","),
    ]);
    this.log("registered via Circle wallet");
    await sleep(SETTLE_WAIT_MS);
  }

  wants(meta) {
    if (!this.cfg.capabilities?.length) return true;
    return this.cfg.capabilities.includes(meta.taskType) || this.cfg.capabilities.includes("general");
  }

  async bidOn(taskId, meta) {
    if (this.seen.has(taskId)) return;
    if (await bidR.auctionClosed(taskId)) return;
    const rep = Number(await reg.getReputation(this.address));
    if (rep < meta.minReputation) return;
    this.seen.add(taskId);
    const markup = this.cfg.markup ?? 0.85;
    const bidAmount = Math.max(0.01, +(meta.budgetUsdc * markup).toFixed(2));
    try {
      await execute(this.address, ADDR.bidEngine, "placeBid(bytes32,uint256,uint256)", [taskId, usdc(bidAmount), 1800]);
      this.log(`bid ${bidAmount} USDC on "${meta.title}"`);
      await sleep(SETTLE_WAIT_MS);
      await execute(this.address, ADDR.bidEngine, "awardBid(bytes32)", [taskId]);
    } catch (e) {
      this.log("bid/award skipped:", e.message);
    }
  }

  async fulfilWins() {
    const head = await provider.getBlockNumber();
    const from = head > LOOKBACK ? head - LOOKBACK : 0;
    const logs = await bidR.queryFilter(bidR.filters.BidAwarded(null, this.address), from, head);
    for (const lg of logs) {
      const taskId = lg.args.taskId;
      if (this.handled.has(taskId)) continue;
      this.handled.add(taskId);
      try {
        const meta = await readTaskMeta(taskId);
        if (!meta) continue;
        this.log(`won "${meta.title}" — producing deliverable…`);
        const deliverable = await produceWork(meta);
        await postJSON(`${API_URL}/api/deliverable`, { taskId, agentWallet: this.address, deliverable });
        const verdict = await postJSON(`${API_URL}/api/verify`, { taskId });
        this.log(`settled "${meta.title}" → ${verdict.score}/100 (${verdict.passed ? "PASS" : "FAIL"})`);
      } catch (e) {
        this.handled.delete(taskId);
        this.log("fulfil error:", e.message);
      }
    }
  }
}

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `POST ${url} failed`);
  return r.json();
}

async function main() {
  requireAddresses(["agentRegistry", "bidEngine", "taskRegistry", "verifierBridge"]);

  if (!(await isLoggedIn())) {
    console.error(
      `Not logged in to Circle (testnet). Run:\n  export CIRCLE_ACCEPT_TERMS=1\n  circle wallet login <email> --type agent\nThen list wallets:  circle wallet list --chain ${CIRCLE_CHAIN} --type agent`,
    );
    process.exit(1);
  }

  let agents = AGENTS;
  if (agents.length === 0) {
    // Auto-map available Circle agent wallets to default personas.
    const wallets = await listAgentWallets();
    const personas = [
      { name: "Atlas-Research", capabilities: ["research", "analysis", "summarization"], markup: 0.85 },
      { name: "Scribe-Writer", capabilities: ["writing", "translation"], markup: 0.9 },
      { name: "Forge-Coder", capabilities: ["code"], markup: 0.88 },
    ];
    agents = wallets.slice(0, personas.length).map((address, i) => ({ ...personas[i], address, stake: 5 }));
    console.log(`Auto-mapped ${agents.length} Circle wallet(s) to personas.`);
  }
  if (agents.length === 0) {
    console.error("No Circle agent wallets found. Run `circle wallet create` after login, then retry.");
    process.exit(1);
  }

  const swarm = agents.map((c) => new CircleAgent(c));
  console.log(`Polaris Circle swarm: ${swarm.length} agent(s) on ${CIRCLE_CHAIN}`);
  for (const a of swarm) await a.ensureRegistered();

  const tick = async () => {
    try {
      const head = await provider.getBlockNumber();
      const from = head > LOOKBACK ? head - LOOKBACK : 0;
      const submitted = await taskReg.queryFilter(taskReg.filters.TaskSubmitted(), from, head);
      for (const lg of submitted) {
        const taskId = lg.args.taskId;
        const t = await taskReg.tasks(taskId);
        if (Number(t.status) !== 0) continue;
        if (t.deadline * 1000n < BigInt(Date.now())) continue;
        const meta = await readTaskMeta(taskId);
        if (!meta) continue;
        for (const a of swarm) if (a.wants(meta)) await a.bidOn(taskId, meta);
      }
      for (const a of swarm) await a.fulfilWins();
    } catch (e) {
      console.error("tick error:", e.message);
    }
  };
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
