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
const POLL_MS = Number(process.env.SWARM_POLL_MS || 30000);
const LOOKBACK = Number(process.env.INDEX_LOOKBACK_BLOCKS || "500000");
// The public Arc RPC has a hard daily request cap. Scanning 500k blocks every
// tick (56 chunks x several filters x agents) exhausts it fast, which then
// breaks the whole app's reads. Scan only a small recent window per tick.
const SWARM_LOOKBACK = Number(process.env.SWARM_LOOKBACK_BLOCKS || "40000");
const SETTLE_WAIT_MS = Number(process.env.CIRCLE_SETTLE_WAIT_MS || 8000);
const usdc = (n) => ethers.parseUnits(String(n), USDC_DECIMALS);

// Agent-to-agent delegation (item 1). OFF by default (threshold 0). When an
// agent already has >= DELEGATE_THRESHOLD in-flight tasks, it sub-contracts a
// new win to another idle agent via submitDirectTask, funded from its own
// wallet at DELEGATE_MARGIN of the budget — keeping the remainder as margin.
const DELEGATE_THRESHOLD = Number(process.env.DELEGATE_THRESHOLD || 0);
const DELEGATE_MARGIN = Number(process.env.DELEGATE_MARGIN || 0.8);

// How long an agent "works" a won task before delivering (kept visible as
// in-progress). Per spec: never less than 20 minutes. Randomized 20–30 min.
const WORK_MIN_MS = Number(process.env.SWARM_WORK_MIN_MS || 20 * 60 * 1000);
const WORK_MAX_MS = Number(process.env.SWARM_WORK_MAX_MS || 30 * 60 * 1000);
// Review retries: a rejected submission is revised with feedback and resubmitted.
const MAX_ATTEMPTS = Number(process.env.MAX_REVIEW_ATTEMPTS || 3);
const REVISE_MS = Number(process.env.SWARM_REVISE_MS || 15000);
// Max tasks an agent will commit to at once (winning-pending bids + in-flight
// work). Keeps work spread across the swarm instead of one agent winning all.
const MAX_INFLIGHT = Number(process.env.SWARM_MAX_INFLIGHT || 1);
// Capability-aware pricing: a specialist bids low (wins on price even vs a
// higher-rep generalist); a generalist fallback bids high (only wins when no
// specialist is available).
const SPECIALIST_MARKUP = Number(process.env.SWARM_SPECIALIST_MARKUP || 0.7);
const GENERALIST_MARKUP = Number(process.env.SWARM_GENERALIST_MARKUP || 0.95);
// Live bidding window: agents bid as soon as they see a task; the auction is
// awarded (best bid wins) only after ~10% of the task's duration so competitors
// have time to bid. Scales with the task deadline; clamped 1 min .. 2 h.
const BID_WINDOW_FRACTION = Number(process.env.BID_WINDOW_FRACTION || 0.1);
const BID_WINDOW_MIN_MS = Number(process.env.BID_WINDOW_MIN_MS || 60 * 1000);
const BID_WINDOW_MAX_MS = Number(process.env.BID_WINDOW_MAX_MS || 2 * 60 * 60 * 1000);

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
    this.activeBids = new Set(); // open auctions this agent has bid on
    this.inFlight = 0; // tasks currently being worked
  }
  /** Tasks this agent is committed to (winning-pending bids + in-flight work). */
  get load() {
    return this.inFlight + this.activeBids.size;
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

  /** This agent's core skills (capabilities minus the "general" fallback flag). */
  get skills() {
    return (this.cfg.capabilities || []).filter((c) => c !== "general");
  }
  /** A specialist for this task: the task type is one of the agent's core skills. */
  isSpecialist(meta) {
    return this.skills.includes(meta.taskType);
  }
  /** A generalist: can backfill any task when no specialist is available. */
  isGeneralist() {
    return (this.cfg.capabilities || []).includes("general");
  }
  wants(meta) {
    if (!this.cfg.capabilities?.length) return true;
    return this.isSpecialist(meta) || this.isGeneralist();
  }

  async bidOn(taskId, meta) {
    if (this.seen.has(taskId)) return;
    // Capacity: a busy agent (working or already holding a winning-pending bid)
    // steps back so work spreads across the swarm instead of one agent hogging it.
    if (this.load >= MAX_INFLIGHT) return;
    if (await bidR.auctionClosed(taskId)) return;
    const rep = Number(await reg.getReputation(this.address));
    if (rep < meta.minReputation) return;
    this.seen.add(taskId);
    // Specialists bid aggressively on their own domain so they beat a higher-rep
    // generalist on price; generalists (fallback) bid conservatively.
    const markup = this.isSpecialist(meta) ? SPECIALIST_MARKUP : GENERALIST_MARKUP;
    const bidAmount = Math.max(0.01, +(meta.budgetUsdc * markup).toFixed(2));
    try {
      await execute(this.address, ADDR.bidEngine, "placeBid(bytes32,uint256,uint256)", [taskId, usdc(bidAmount), 1800]);
      this.activeBids.add(taskId);
      this.log(`bid ${bidAmount} USDC on "${meta.title}"`);
      // Live bidding window: don't award immediately. Wait ~BID_WINDOW_FRACTION of
      // the remaining task time (clamped) so competitors can bid, THEN close the
      // auction. awardBid picks the best bid + is idempotent (auctionClosed guard),
      // so whichever agent fires first just finalizes the winner.
      const remaining = Math.max(0, meta.deadline - Date.now());
      const windowMs = Math.min(BID_WINDOW_MAX_MS, Math.max(BID_WINDOW_MIN_MS, Math.floor(remaining * BID_WINDOW_FRACTION)));
      setTimeout(async () => {
        try {
          if (await bidR.auctionClosed(taskId)) return;
          await execute(this.address, ADDR.bidEngine, "awardBid(bytes32)", [taskId]);
          this.log(`bidding closed for "${meta.title}" — best bid awarded`);
        } catch {
          /* another agent likely closed it first */
        }
      }, windowMs);
    } catch (e) {
      this.log("bid skipped:", e.message);
    }
  }

  /** Work a task this agent has been assigned (driven by the backend index). */
  async fulfil(taskId, meta) {
    this.activeBids.delete(taskId); // bid resolved into a win → counts as in-flight now
    if (this.handled.has(taskId)) return;
    this.handled.add(taskId);
    try {
      // Delegate if over capacity and a peer can take it.
      if (DELEGATE_THRESHOLD > 0 && this.inFlight >= DELEGATE_THRESHOLD) {
        const peer = SWARM.find((a) => a !== this && a.cfg && a.wants(meta) && a.address !== this.address);
        if (peer && (await this.delegate(taskId, meta, peer))) return;
      }

      this.inFlight += 1;
      // Take a realistic amount of time to "work" the task (stays ASSIGNED /
      // in-progress meanwhile), then produce + deliver + review. Reviewer feedback
      // from a prior rejection (meta.feedback) is folded into the work so re-bids improve.
      const workMs = WORK_MIN_MS + Math.floor(Math.random() * Math.max(0, WORK_MAX_MS - WORK_MIN_MS));
      this.log(`won "${meta.title}" — working (~${Math.round(workMs / 1000)}s)…`);
      await sleep(workMs);

      const deliverable = await produceWork(meta, meta.feedback || "");
      await postJSON(`${API_URL}/api/deliverable`, { taskId, agentWallet: this.address, deliverable });
      const result = await postJSON(`${API_URL}/api/verify`, { taskId });
      if (result.status === "released") {
        this.log(`PASS "${meta.title}" ${result.score}/100 → USDC released`);
      } else if (result.status === "slashed") {
        this.log(`SLASHED "${meta.title}" ${result.score}/100 (late final fail)`);
      } else {
        // rejected: the backend reopened the task to the market; we'll re-bid (or
        // a competitor will) on a later tick, now with reviewer feedback attached.
        this.log(`rejected "${meta.title}" ${result.score}/100${result.reopened ? " → returned to market" : ""}: ${String(result.feedback || "").slice(0, 90)}`);
      }
      this.inFlight -= 1;
    } catch (e) {
      this.handled.delete(taskId);
      if (this.inFlight > 0) this.inFlight -= 1;
      this.log("fulfil error:", e.message);
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

  // Discovery is driven by the backend index (which folds ALL tasks/agents from
  // chain logs) instead of the swarm doing its own heavy getLogs every tick —
  // this is far lighter on the RPC and lets the swarm see tasks of any age.
  const normalize = (t) => ({
    taskId: t.taskId,
    title: t.title,
    description: t.description,
    rubric: t.rubric,
    taskType: t.taskType || "general",
    budgetUsdc: t.budgetUsdc,
    minReputation: t.minReputation || 0,
    deadline: t.deadlineMs, // ms
    feedback: t.feedback || "", // reviewer feedback from a prior rejection
  });

  // Track each task's last-seen status so we can detect a reopen (ASSIGNED→OPEN)
  // and let agents bid again on it.
  const lastStatus = new Map();

  const tick = async () => {
    try {
      const res = await fetch(`${API_URL}/api/index`);
      const index = await res.json();
      const tasks = index.tasks || [];
      const now = Date.now();
      for (const t of tasks) {
        const meta = normalize(t);
        // Reopened? clear every agent's seen/handled for this task so it's biddable again.
        const prev = lastStatus.get(t.taskId);
        if (t.status === "OPEN" && (prev === "ASSIGNED" || prev === "IN_PROGRESS")) {
          for (const a of swarm) {
            a.seen.delete(t.taskId);
            a.handled.delete(t.taskId);
          }
        }
        lastStatus.set(t.taskId, t.status);

        if (t.status === "OPEN") {
          if (meta.deadline < now) continue;
          // Specialist-first dispatch: only agents whose core skills match the
          // task type bid. Generalists backfill ONLY when no specialist is free,
          // so a writing task goes to a writer, not a high-rep code agent.
          const free = (a) => a.load < MAX_INFLIGHT;
          const specialists = swarm.filter((a) => a.isSpecialist(meta) && free(a));
          const bidders = specialists.length > 0 ? specialists : swarm.filter((a) => a.isGeneralist() && free(a));
          for (const a of bidders) await a.bidOn(meta.taskId, meta);
        } else if (t.status === "ASSIGNED" || t.status === "IN_PROGRESS") {
          const winner = (t.assignedAgent || "").toLowerCase();
          // Free capacity for agents that bid but lost this auction.
          for (const a of swarm) if (a.address.toLowerCase() !== winner) a.activeBids.delete(t.taskId);
          const a = swarm.find((x) => x.address.toLowerCase() === winner);
          if (a) await a.fulfil(meta.taskId, meta);
        } else {
          // settled/cancelled — clear any lingering bid commitment
          for (const a of swarm) a.activeBids.delete(t.taskId);
        }
      }
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
