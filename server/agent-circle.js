import { ethers } from "ethers";
import "dotenv/config";

import { ADDR, ABI, provider, readTaskMeta, USDC_DECIMALS, requireAddresses, queryLogsChunked } from "./chain.js";
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

// Agent-to-agent delegation (item 1). OFF by default (threshold 0). When an
// agent already has >= DELEGATE_THRESHOLD in-flight tasks, it sub-contracts a
// new win to another idle agent via submitDirectTask, funded from its own
// wallet at DELEGATE_MARGIN of the budget — keeping the remainder as margin.
const DELEGATE_THRESHOLD = Number(process.env.DELEGATE_THRESHOLD || 0);
const DELEGATE_MARGIN = Number(process.env.DELEGATE_MARGIN || 0.8);

// How long an agent "works" a won task before delivering (kept visible as
// in-progress). Randomized per task between MIN and MAX.
const WORK_MIN_MS = Number(process.env.SWARM_WORK_MIN_MS || 45000);
const WORK_MAX_MS = Number(process.env.SWARM_WORK_MAX_MS || 150000);

/** @type {{name:string,address:string,capabilities:string[],stake:number,markup:number}[]} */
const AGENTS = JSON.parse(process.env.AGENTS_CIRCLE_JSON || "[]");

// pending delegations: childTaskId -> { parentTaskId, primary, subAgent }
const delegations = new Map();
let SWARM = [];

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
    this.inFlight = 0;
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
    const stakeAmt = usdc(this.cfg.stake ?? 100);
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
    const logs = await queryLogsChunked(bidR, bidR.filters.BidAwarded(null, this.address));
    for (const lg of logs) {
      const taskId = lg.args.taskId;
      if (this.handled.has(taskId)) continue;
      this.handled.add(taskId);
      try {
        const meta = await readTaskMeta(taskId);
        if (!meta) continue;

        // Delegate if over capacity and a peer can take it.
        if (DELEGATE_THRESHOLD > 0 && this.inFlight >= DELEGATE_THRESHOLD) {
          const peer = SWARM.find((a) => a !== this && a.cfg && a.wants(meta) && a.address !== this.address);
          if (peer && (await this.delegate(taskId, meta, peer))) continue;
        }

        this.inFlight += 1;
        // Take a realistic amount of time to "work" the task (stays ASSIGNED /
        // in-progress meanwhile), then produce + deliver + settle.
        const workMs = WORK_MIN_MS + Math.floor(Math.random() * Math.max(0, WORK_MAX_MS - WORK_MIN_MS));
        this.log(`won "${meta.title}" — working (~${Math.round(workMs / 1000)}s)…`);
        await sleep(workMs);
        const deliverable = await produceWork(meta);
        await postJSON(`${API_URL}/api/deliverable`, { taskId, agentWallet: this.address, deliverable });
        this.log(`delivered "${meta.title}" — submitting for verification…`);
        const verdict = await postJSON(`${API_URL}/api/verify`, { taskId });
        this.inFlight -= 1;
        this.log(`settled "${meta.title}" → ${verdict.score}/100 (${verdict.passed ? "PASS" : "FAIL"})`);
      } catch (e) {
        this.handled.delete(taskId);
        if (this.inFlight > 0) this.inFlight -= 1;
        this.log("fulfil error:", e.message);
      }
    }
  }

  /** Sub-contract a parent task to a peer agent via a funded direct task. */
  async delegate(parentTaskId, meta, peer) {
    try {
      const subBudget = Math.max(0.01, +(meta.budgetUsdc * DELEGATE_MARGIN).toFixed(2));
      const childId = ethers.hexlify(ethers.randomBytes(32));
      const deadline = Math.floor(meta.deadline / 1000);
      await execute(this.address, ADDR.usdc, "approve(address,uint256)", [ADDR.escrow, usdc(subBudget)]);
      await sleep(SETTLE_WAIT_MS);
      await execute(this.address, ADDR.taskRegistry, "submitDirectTask(bytes32,address,uint256,uint256,string,string,string,string)", [
        childId, peer.address, usdc(subBudget), deadline, meta.title, meta.description, meta.rubric, meta.taskType,
      ]);
      delegations.set(childId, { parentTaskId, primary: this, subAgent: peer.address });
      this.log(`delegated "${meta.title}" → ${peer.cfg.name} (sub-budget ${subBudget} USDC, keeps margin)`);
      return true;
    } catch (e) {
      this.log("delegation failed, will do it myself:", e.message);
      return false;
    }
  }
}

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `POST ${url} failed`);
  return r.json();
}

/** When a delegated (child) task settles, forward its deliverable to the parent. */
async function resolveDelegations() {
  for (const [childId, d] of [...delegations]) {
    let status;
    try {
      status = Number((await taskReg.tasks(childId)).status);
    } catch {
      continue;
    }
    if (status === 4) {
      // child SETTLED → fetch the sub-agent's deliverable, submit it for the parent
      try {
        const res = await fetch(`${API_URL}/api/deliverable/${childId}`);
        const { deliverable } = await res.json();
        if (!deliverable) continue;
        await postJSON(`${API_URL}/api/deliverable`, { taskId: d.parentTaskId, agentWallet: d.primary.address, deliverable });
        const verdict = await postJSON(`${API_URL}/api/verify`, { taskId: d.parentTaskId });
        d.primary.log(`parent settled via delegation → ${verdict.score}/100 (kept margin)`);
        delegations.delete(childId);
      } catch (e) {
        d.primary.log("delegation resolve retry:", e.message);
      }
    } else if (status === 5) {
      // child failed/cancelled → primary will handle the parent itself next tick
      delegations.delete(childId);
      d.primary.handled.delete(d.parentTaskId);
    }
  }
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
      { name: "Nova-Analyst", capabilities: ["analysis", "research", "general"], markup: 0.82 },
      { name: "Vega-Generalist", capabilities: ["general", "writing", "summarization"], markup: 0.8 },
    ];
    agents = wallets.slice(0, personas.length).map((address, i) => ({ ...personas[i], address, stake: 100 }));
    console.log(`Auto-mapped ${agents.length} Circle wallet(s) to personas.`);
  }
  if (agents.length === 0) {
    console.error("No Circle agent wallets found. Run `circle wallet create` after login, then retry.");
    process.exit(1);
  }

  const swarm = agents.map((c) => new CircleAgent(c));
  SWARM = swarm;
  console.log(`Polaris Circle swarm: ${swarm.length} agent(s) on ${CIRCLE_CHAIN}`);
  for (const a of swarm) await a.ensureRegistered();

  const tick = async () => {
    try {
      const submitted = await queryLogsChunked(taskReg, taskReg.filters.TaskSubmitted());
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
      await resolveDelegations();
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
