import { ethers } from "ethers";
import "dotenv/config";

import { ADDR, ABI, provider, readTaskMeta, USDC_DECIMALS, requireAddresses, queryLogsChunked } from "./chain.js";
import { produceWork } from "./score.js";
import { clearFailures, exhausted, FULFIL_MAX_ATTEMPTS, recordFailure } from "./fulfilAttempts.js";
import { DEFAULT_NETWORK, getNetwork } from "./networks.js";

/** This swarm is Arc-only: Circle MPC wallets have no BOT Chain presence. */
const ARC_CHAIN_ID = getNetwork(DEFAULT_NETWORK).chainId;
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
// Work capacity: how many tasks an agent actually WORKS at once. Kept at 1 so an
// agent finishes one job before starting the next (realistic, avoids missed
// deadlines). Winning a 2nd auction while busy → delegate to a free peer or defer.
const MAX_INFLIGHT = Number(process.env.SWARM_MAX_INFLIGHT || 1);
// Bid capacity: how many OPEN auctions an agent may have a live bid in at once.
// Decoupled from work so each task draws bids from several agents (a bid is cheap;
// only the won job ties up work capacity). This is what gives tasks many bidders.
const MAX_BIDS = Number(process.env.SWARM_MAX_BIDS || 3);
// Capability-aware pricing: a specialist bids low (wins on price even vs a
// higher-rep generalist); a generalist fallback bids high (only wins when no
// specialist is available).
const SPECIALIST_MARKUP = Number(process.env.SWARM_SPECIALIST_MARKUP || 0.7);
const GENERALIST_MARKUP = Number(process.env.SWARM_GENERALIST_MARKUP || 0.95);
// Live bidding window: agents bid as they see a task; the auction is awarded
// (best bid wins) only after a fixed 20 minutes so competitors — including agents
// that were busy and only just freed up — have time to bid. Clamped to the time
// left before the deadline.
const BID_WINDOW_MS = Number(process.env.BID_WINDOW_MS || 20 * 60 * 1000);

/** @type {{name:string,address:string,capabilities:string[],stake:number,markup:number}[]} */
const AGENTS = JSON.parse(process.env.AGENTS_CIRCLE_JSON || "[]");

// pending delegations: childTaskId -> { parentTaskId, primary, subAgent }
const delegations = new Map();
let SWARM = [];

// Fairness now lives ON-CHAIN: the BidEngine scores every bid with
// price·30 + rep·25 + speed·15 + random·30, so a high-reputation agent no longer
// wins every auction. The swarm therefore goes back to open competition — every
// capable agent bids and the chain's lottery decides — instead of pre-selecting
// one bidder off-chain.

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
    // Bid capacity (not work capacity): an agent can have live bids in several
    // open auctions at once. It only stops bidding when it's already holding
    // MAX_BIDS live bids — winning ties up work capacity, bidding does not.
    if (this.activeBids.size >= MAX_BIDS) return;
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
      // Deliberately does NOT schedule the award. This used to arrange it with a
      // setTimeout, and a restart forgets a timer: the auction stayed open with bids on
      // it and nothing left to close it. The tick recomputes the window from chain data
      // every pass and closes it there instead.
    } catch (e) {
      this.log("bid skipped:", e.message);
    }
  }

  /** Work a task this agent has been assigned (driven by the backend index). */
  async fulfil(taskId, meta) {
    this.activeBids.delete(taskId); // bid resolved into a win → no longer a live bid
    if (this.handled.has(taskId)) return;

    // Already at work capacity (won a 2nd auction while busy): hand it to a free
    // peer; if none is free, DEFER — leave it unhandled so a later tick runs it
    // once this agent frees up. Never work two jobs concurrently.
    if (this.inFlight >= MAX_INFLIGHT) {
      const peer = SWARM.find((a) => a !== this && a.cfg && a.wants(meta) && a.inFlight < MAX_INFLIGHT);
      if (peer && (await this.delegate(taskId, meta, peer))) {
        this.handled.add(taskId);
      }
      return; // delegated (handled) or deferred (retried next tick)
    }

    this.handled.add(taskId);
    try {
      this.inFlight += 1;
      // Take a realistic amount of time to "work" the task (stays ASSIGNED /
      // in-progress meanwhile), then produce + deliver + review. Reviewer feedback
      // from a prior rejection (meta.feedback) is folded into the work so re-bids improve.
      const workMs = WORK_MIN_MS + Math.floor(Math.random() * Math.max(0, WORK_MAX_MS - WORK_MIN_MS));
      this.log(`won "${meta.title}" — working (~${Math.round(workMs / 1000)}s)…`);
      await sleep(workMs);

      const { deliverable, gradeableText } = await produceWork(meta, meta.feedback || "");
      // NOTE: unlike the raw-key swarm (agent.js) and hosted personas (hosted.js),
      // Circle MPC agent wallets have no off-chain message-signing capability
      // wired up here (circle-wallet.js only exposes `wallet execute` for
      // on-chain contract calls) — see docs/AUDIT_REPORT.md, Security #2. The
      // backend still binds this submission to the real on-chain assigned agent
      // (server/server.js), but cannot cryptographically verify this specific
      // POST came from that agent's own process without a Circle CLI/API
      // message-signing subcommand, which isn't confirmed available.
      await postJSON(`${API_URL}/api/deliverable`, { taskId, agentWallet: this.address, deliverable, gradeableText });
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
      clearFailures(ARC_CHAIN_ID, taskId);
    } catch (e) {
      if (this.inFlight > 0) this.inFlight -= 1;
      // Same bounded retry as the raw-key swarm (server/agent.js). Clearing `handled`
      // unconditionally meant a task that could never succeed was re-attempted every tick,
      // paying for a model call each pass while pinned in ASSIGNED.
      const n = recordFailure(ARC_CHAIN_ID, taskId, e.message);
      if (n >= FULFIL_MAX_ATTEMPTS) {
        this.log(
          `giving up on ${String(taskId).slice(0, 10)} after ${n} attempts: ${e.message}. ` +
            `Leaving it for the deadline reaper.`,
        );
      } else {
        this.handled.delete(taskId);
        this.log(`fulfil error (attempt ${n}/${FULFIL_MAX_ATTEMPTS}):`, e.message);
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

// Resilient GET: the Railway edge / Arc RPC occasionally return a plain-text
// body like "upstream error" (502) instead of JSON. Read text-first so a bad
// body never throws a JSON parse error, and retry transient failures with
// backoff so a blip doesn't skip a whole poll cycle or spam "tick error".
async function getJSON(url, { retries = 3, backoffMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url);
      const text = await r.text();
      if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${text.slice(0, 80)}`);
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`non-JSON from ${url}: ${text.slice(0, 80)}`);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

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

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: internalHeaders(), body: JSON.stringify(body) });
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body (e.g. a gateway "upstream error") — leave data empty */
  }
  if (!r.ok) throw new Error(data.error || `POST ${url} -> ${r.status} ${text.slice(0, 80)}`);
  return data;
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
        const { deliverable } = await getJSON(`${API_URL}/api/deliverable/${childId}`);
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
      { name: "Vega-Generalist", capabilities: ["general", "writing", "summarization", "design", "graphics", "logo", "image"], markup: 0.8 },
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
  const planSeen = new Set(); // `${agentAddr}:${planId}` we've already bid on
  const reworking = new Set(); // taskIds currently being reworked (dispute upheld)

  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a previous tick is still in flight — don't overlap
    ticking = true;
    try {
      const index = await getJSON(`${API_URL}/api/index`);
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

          // The auction's clock, derived from chain data rather than scheduled. `bidOn` used
          // to arrange the close with a setTimeout, and a restart forgets a timer: the task
          // stayed OPEN with bids on it and nothing left to award it, which is exactly the
          // "agents bid but nothing gets assigned" symptom. Recomputing it every tick means
          // any process, at any time, reaches the same verdict.
          const createdAtMs = t.createdAtMs ?? now;
          const windowMs = Math.min(BID_WINDOW_MS, Math.max(0, meta.deadline - createdAtMs));
          const bidCount = (index.bids || []).filter((b) => b.taskId === t.taskId).length;

          if (now < createdAtMs + windowMs) {
            // Open competition: every capable agent with spare bid capacity bids, so
            // a task draws multiple bids. The winner is decided ON-CHAIN by the
            // BidEngine's score.
            const canBid = (a) => a.wants(meta) && a.activeBids.size < MAX_BIDS;
            for (const a of swarm.filter(canBid)) await a.bidOn(meta.taskId, meta);
          } else if (bidCount > 0) {
            // Window over and somebody bid: close it so the best bid actually wins.
            // `awardBid` guards on `auctionClosed`, so racing agents just finalise once.
            const closer = swarm[0];
            try {
              await execute(closer.address, ADDR.bidEngine, "awardBid(bytes32)", [meta.taskId]);
              closer.log(`bidding closed for "${meta.title}" — best bid awarded`);
            } catch (e) {
              const msg = e.message || "";
              if (!/Auction closed|No bids/i.test(msg)) closer.log("award skipped:", msg);
            }
          }
        } else if (t.status === "ASSIGNED" || t.status === "IN_PROGRESS") {
          const winner = (t.assignedAgent || "").toLowerCase();
          // Free capacity for agents that bid but lost this auction.
          for (const a of swarm) if (a.address.toLowerCase() !== winner) a.activeBids.delete(t.taskId);
          const a = swarm.find((x) => x.address.toLowerCase() === winner);
          // Deliberately NOT awaited: fulfil() sleeps 20-30 min to simulate work,
          // and awaiting it here would block this whole tick loop (bidding on
          // every other open task) for that entire window. fulfil() already
          // guards re-entrancy via `handled`/`inFlight` and never rethrows.
          if (a) a.fulfil(meta.taskId, meta).catch((e) => a.log("fulfil error:", e.message));
        } else {
          // settled/cancelled — clear any lingering bid commitment
          for (const a of swarm) a.activeBids.delete(t.taskId);
        }
      }

      // Recurring-market auctions: capable agents bid a per-delivery price; the
      // backend scheduler closes the auction and runs the deliveries on schedule.
      try {
        const { plans = [] } = await getJSON(`${API_URL}/api/recurring-plans`);
        for (const p of plans) {
          if (p.status !== "OPEN") continue;
          const meta = { taskType: p.taskType || "general", title: p.title, minReputation: p.minReputation || 0 };
          for (const a of swarm) {
            const key = `${a.address}:${p.planId}`;
            if (planSeen.has(key) || !a.wants(meta)) continue;
            const markup = a.isSpecialist(meta) ? SPECIALIST_MARKUP : GENERALIST_MARKUP;
            const price = Math.max(0.01, Math.min(p.perDeliveryUsdc, +(p.perDeliveryUsdc * markup).toFixed(2)));
            planSeen.add(key);
            try {
              await execute(a.address, ADDR.recurringMarket, "bid(bytes32,uint256,uint256)", [p.planId, usdc(price), 1800]);
              a.log(`bid ${price} USDC/delivery on recurring "${p.title}"`);
            } catch {
              /* rep too low / already bid / offline — skip */
            }
          }
        }
      } catch {
        /* recurring endpoint optional */
      }

      // Rework queue: an UPHELD dispute asks the assigned agent to redo the work.
      try {
        const { reworks = {} } = await getJSON(`${API_URL}/api/reworks`);
        for (const key of Object.keys(reworks)) {
          if (reworking.has(key)) continue;
          const t = tasks.find((x) => x.taskId.toLowerCase() === key);
          if (!t) continue;
          const a = swarm.find((x) => x.address.toLowerCase() === (t.assignedAgent || "").toLowerCase());
          if (!a) continue; // not one of our agents
          reworking.add(key);
          const rw = reworks[key];
          (async () => {
            try {
              const meta = normalize(t);
              a.log(`reworking "${meta.title}" (dispute upheld) — regenerating deliverable…`);
              const { deliverable, gradeableText } = await produceWork(meta, rw.feedback || "");
              await postJSON(`${API_URL}/api/deliverable`, { taskId: t.taskId, agentWallet: a.address, deliverable, gradeableText });
              await postJSON(`${API_URL}/api/rework-done`, { taskId: t.taskId });
              a.log(`rework delivered for "${meta.title}"`);
            } catch (e) {
              a.log("rework error:", e.message);
              reworking.delete(key); // retry next tick
            }
          })();
        }
      } catch {
        /* reworks endpoint optional */
      }

      await resolveDelegations();
    } catch (e) {
      console.error("tick error:", e.message);
    } finally {
      ticking = false;
    }
  };
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
