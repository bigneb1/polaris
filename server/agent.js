import { ethers } from "ethers";
import "dotenv/config";

import { ADDR, ABI, provider, readTaskMeta, USDC_DECIMALS, requireAddresses, queryLogsChunked } from "./chain.js";
import { produceWork } from "./score.js";
import { payForService } from "./x402.js";

// Opt-in: agents pay $0.01 via x402/Gateway for a price-oracle sub-service before
// doing work — demonstrates agent-to-agent nanopayments (requires Gateway USDC).
const X402_ORACLE = process.env.X402_PAY_FOR_ORACLE === "1" ? process.env.X402_ORACLE_URL : null;

/**
 * Polaris autonomous agent runtime — the swarm.
 *
 * This is the "agency" of Polaris: registered agents run as background processes
 * that, with NO human clicking buttons:
 *   1. register on-chain if needed (stake USDC)
 *   2. poll for OPEN tasks via TaskSubmitted events
 *   3. DECIDE whether to bid (capability match + reputation gate + price policy)
 *   4. place a bid, then close the auction (awardBid)
 *   5. if they win, DO the work, submit the deliverable, and trigger
 *      verification — which settles USDC on-chain
 *
 * Configure one or more agents via AGENTS_JSON (see .env.example). Each agent is
 * its own funded wallet on Arc.
 */
const API_URL = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const POLL_MS = Number(process.env.SWARM_POLL_MS || 12000);
const LOOKBACK = Number(process.env.INDEX_LOOKBACK_BLOCKS || "500000");
const usdc = (n) => ethers.parseUnits(String(n), USDC_DECIMALS);

/** @type {{name:string, key:string, capabilities:string[], stake:number, markup:number}[]} */
const AGENTS = JSON.parse(process.env.AGENTS_JSON || "[]");

function agentId(name, wallet) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${name.toLowerCase()}:${wallet.toLowerCase()}`));
}

class Agent {
  constructor(cfg) {
    this.cfg = cfg;
    this.wallet = new ethers.Wallet(cfg.key, provider);
    this.reg = new ethers.Contract(ADDR.agentRegistry, ABI.agentRegistry, this.wallet);
    this.bid = new ethers.Contract(ADDR.bidEngine, ABI.bidEngine, this.wallet);
    this.usdc = new ethers.Contract(ADDR.usdc, ABI.erc20, this.wallet);
    this.seen = new Set();      // taskIds we've already bid on
    this.handled = new Set();   // taskIds we've already worked + submitted
  }

  log(...a) {
    console.log(`[${this.cfg.name}]`, ...a);
  }

  async ensureRegistered() {
    const info = await this.reg.agents(this.wallet.address);
    if (info.registered) {
      if (!info.online) {
        await (await this.reg.restake(0)).wait();
        this.log("came back online");
      }
      return;
    }
    const stake = usdc(this.cfg.stake ?? 100);
    const allowance = await this.usdc.allowance(this.wallet.address, ADDR.agentRegistry);
    if (allowance < stake) await (await this.usdc.approve(ADDR.agentRegistry, stake)).wait();
    await (
      await this.reg.register(
        agentId(this.cfg.name, this.wallet.address),
        stake,
        this.cfg.name,
        (this.cfg.capabilities || []).join(","),
      )
    ).wait();
    this.log("registered on-chain with", this.cfg.stake ?? 100, "USDC stake");
  }

  /** Does this agent want this task? Capability match is the core decision. */
  wants(meta) {
    if (!this.cfg.capabilities?.length) return true; // generalist
    return this.cfg.capabilities.includes(meta.taskType) || this.cfg.capabilities.includes("general");
  }

  async bidOn(taskId, meta) {
    if (this.seen.has(taskId)) return;
    if (await this.bid.auctionClosed(taskId)) return;
    const rep = Number(await this.reg.getReputation(this.wallet.address));
    if (rep < meta.minReputation) return;

    this.seen.add(taskId);
    // Price policy: undercut the budget by the agent's markup (lower bid = higher score).
    const markup = this.cfg.markup ?? 0.85;
    const bidAmount = Math.max(0.01, +(meta.budgetUsdc * markup).toFixed(2));
    const etaSeconds = 1800;
    try {
      await (await this.bid.placeBid(taskId, usdc(bidAmount), etaSeconds)).wait();
      this.log(`bid ${bidAmount} USDC on "${meta.title}" (#${taskId.slice(2, 10)})`);
      // Close the auction so assignment happens (deterministic best-score winner).
      await (await this.bid.awardBid(taskId)).wait();
    } catch (e) {
      this.log("bid/award skipped:", e.shortMessage || e.message);
    }
  }

  /** If we won and haven't delivered yet, do the work and trigger settlement. */
  async fulfilWins() {
    const logs = await queryLogsChunked(this.bid, this.bid.filters.BidAwarded(null, this.wallet.address));
    for (const lg of logs) {
      const taskId = lg.args.taskId;
      if (this.handled.has(taskId)) continue;
      this.handled.add(taskId);
      try {
        const meta = await readTaskMeta(taskId);
        if (!meta) continue;
        // Optional: pay a sub-cent x402 nanopayment for an oracle quote first.
        if (X402_ORACLE) {
          try {
            const { data } = await payForService(X402_ORACLE, this.cfg.key);
            this.log(`x402 paid $0.01 for oracle → quote ${data?.usdcQuote ?? "?"}`);
          } catch (e) {
            this.log("x402 oracle pay skipped:", e.message);
          }
        }
        this.log(`won "${meta.title}" — producing deliverable…`);
        const deliverable = await produceWork(meta);
        await postJSON(`${API_URL}/api/deliverable`, {
          taskId,
          agentWallet: this.wallet.address,
          deliverable,
        });
        const verdict = await postJSON(`${API_URL}/api/verify`, { taskId });
        this.log(`settled "${meta.title}" → ${verdict.score}/100 (${verdict.passed ? "PASS" : "FAIL"})`);
      } catch (e) {
        this.handled.delete(taskId); // allow retry next loop
        this.log("fulfil error:", e.message);
      }
    }
  }
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `POST ${url} failed`);
  return r.json();
}

async function main() {
  requireAddresses(["agentRegistry", "bidEngine", "taskRegistry", "verifierBridge"]);
  if (AGENTS.length === 0) {
    console.error("No agents configured. Set AGENTS_JSON in .env (see .env.example).");
    process.exit(1);
  }

  const taskReg = new ethers.Contract(ADDR.taskRegistry, ABI.taskRegistry, provider);
  const agents = AGENTS.map((c) => new Agent(c));

  console.log(`Polaris swarm starting with ${agents.length} agent(s)…`);
  for (const a of agents) await a.ensureRegistered();

  const tick = async () => {
    try {
      const submitted = await queryLogsChunked(taskReg, taskReg.filters.TaskSubmitted());

      for (const lg of submitted) {
        const taskId = lg.args.taskId;
        const t = await taskReg.tasks(taskId);
        if (Number(t.status) !== 0) continue; // 0 = OPEN; skip assigned/settled
        if (t.deadline * 1000n < BigInt(Date.now())) continue; // expired
        const meta = await readTaskMeta(taskId);
        if (!meta) continue;
        for (const a of agents) {
          if (a.wants(meta)) await a.bidOn(taskId, meta);
        }
      }
      for (const a of agents) await a.fulfilWins();
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
