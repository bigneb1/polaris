import { ethers } from "ethers";
import {
  agentIdOf,
  agentUriFor,
  erc8004Available,
  ensureIdentity,
  identityContract,
  parseRegisteredId,
  recordAgentId,
  requestValidation,
  validationRequestHash,
} from "./erc8004.js";
import { accountOf, bundlingAvailable, ensureAccount, sendUserOperation } from "./bundler.js";
import "dotenv/config";

import { getChainCtx } from "./chain.js";
import { DEFAULT_NETWORK, getNetwork, isDeployed } from "./networks.js";
import { produceWork } from "./score.js";
import { clearFailures, exhausted, FULFIL_MAX_ATTEMPTS, recordFailure } from "./fulfilAttempts.js";
import { payForService } from "./x402.js";

/**
 * Polaris autonomous agent runtime — the swarm.
 *
 * This is the "agency" of Polaris: registered agents run as background processes
 * that, with NO human clicking buttons:
 *   1. register on-chain if needed (stake the network's escrow asset)
 *   2. poll for OPEN tasks via TaskSubmitted events
 *   3. DECIDE whether to bid (capability match + reputation gate + price policy)
 *   4. place a bid, then close the auction (awardBid)
 *   5. if they win, DO the work, submit the deliverable, and trigger
 *      verification — which settles on-chain
 *
 * MULTI-CHAIN: a swarm instance is bound to ONE network. Its wallets, contracts,
 * gas token and API calls are all that network's — an agent configured for BOT
 * Chain can never bid on an Arc task. Configure per network with
 * `AGENTS_JSON_<NETWORK>` (e.g. AGENTS_JSON_BOTCHAIN_TESTNET), falling back to
 * the shared `AGENTS_JSON` for Arc's existing setup.
 *
 * On BOT Chain gas is native BOT (not the stablecoin), so each agent's gas
 * balance is checked before it commits to work it couldn't pay to submit.
 */
const API_URL = process.env.VITE_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const POLL_MS = Number(process.env.SWARM_POLL_MS || 12000);
/** Native coin held back for gas, so staking can never leave an agent unable to
 *  pay for the bid and submission that follow. Only meaningful where the stake and
 *  the gas are the same coin (BOT Chain). */
const GAS_RESERVE = ethers.parseEther(process.env.SWARM_GAS_RESERVE || "0.05");
/**
 * How long an auction stays open before it is awarded.
 *
 * This swarm used to award the instant it bid, which made the market first-poll-wins: the
 * first agent to notice a task bid and closed the auction in the same breath, every other
 * agent hit the `auctionClosed` guard, and BidEngine's scoring (price 40% / reputation 40%
 * / speed 20%) never saw a second bid to compare. The UI has always advertised a 20-minute
 * window and `lib/utils.ts` even says it "mirrors the swarm's BID_WINDOW_MS" — a constant
 * that existed in the Circle swarm and not here, which is the mode BOT Chain runs.
 */
const BID_WINDOW_MS = Number(process.env.BID_WINDOW_MS || 20 * 60 * 1000);

/** `botchain-testnet` → `BOTCHAIN_TESTNET` */
const envKey = (id) => id.replace(/-/g, "_").toUpperCase();

/** Agents configured for a network. */
function agentsFor(networkId) {
  const raw = process.env[`AGENTS_JSON_${envKey(networkId)}`] ?? (networkId === DEFAULT_NETWORK ? process.env.AGENTS_JSON : "[]");
  try {
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    console.error(`[swarm:${networkId}] AGENTS_JSON is not valid JSON — no agents started.`);
    return [];
  }
}

function agentId(name, wallet) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${name.toLowerCase()}:${wallet.toLowerCase()}`));
}

class Agent {
  constructor(cfg, ctx) {
    this.cfg = cfg;
    this.ctx = ctx;
    this.wallet = new ethers.Wallet(cfg.key, ctx.provider);
    this.reg = new ethers.Contract(ctx.ADDR.agentRegistry, ctx.ABI.agentRegistry, this.wallet);
    this.bid = new ethers.Contract(ctx.ADDR.bidEngine, ctx.ABI.bidEngine, this.wallet);
    // Native networks (BOT Chain) have no escrow token, value moves as msg.value.
    this.native = Boolean(ctx.asset.native);
    this.token = this.native ? null : new ethers.Contract(ctx.ADDR.usdc, ctx.ABI.erc20, this.wallet);
    this.seen = new Set(); // taskIds we've already bid on
    this.handled = new Set(); // taskIds we've already worked + submitted
    this.outOfGas = false;

    /**
     * ERC-4337 mode. When on, the agent's on-chain identity is a PolarisAccount and
     * its transactions are delivered as UserOperations through the EntryPoint, with
     * the runtime bundling them itself (BOT Chain has no public bundler).
     *
     * `this.address` is what the market sees, so everything that reads or writes an
     * agent's registry entry must use it rather than the owner key: the registry
     * knows the ACCOUNT as the agent, and the key is only its signer.
     */
    const wanted = cfg.smartAccount ?? process.env.SWARM_SMART_ACCOUNTS === "1";
    this.useAccount = Boolean(wanted && bundlingAvailable(ctx));
    if (wanted && !this.useAccount) {
      this.log("smart-account mode requested but this network has no account factory, using the raw key");
    }
    this.account = null; // resolved in start()
    this.address = this.wallet.address;
  }

  /**
   * Resolve this agent's on-chain identity.
   *
   * In smart-account mode the identity is a PolarisAccount derived from the owner
   * key, deployed and topped up with EntryPoint deposit if needed. Called once
   * before the agent registers, because everything afterwards (registry entry,
   * bids, payouts) belongs to the ACCOUNT, not the key.
   */
  async resolveIdentity() {
    if (!this.useAccount) return this.address;
    const relayer = this.ctx.signer();
    if (!relayer) {
      this.log("no relayer key on this runtime, falling back to the raw key");
      this.useAccount = false;
      return this.address;
    }
    this.account = await ensureAccount(this.ctx, relayer, this.wallet.address, {
      deposit: process.env.SWARM_ACCOUNT_DEPOSIT || "0.02",
    });
    this.address = this.account;
    this.log(`acting through ERC-4337 account ${this.account} (owner ${this.wallet.address})`);
    return this.address;
  }

  /**
   * Send one contract call as this agent.
   *
   * Raw-key mode signs and sends it directly. Smart-account mode wraps it in a
   * UserOperation, has the owner key sign the userOpHash, and submits it through
   * `EntryPoint.handleOps` from the relayer.
   *
   * A failed UserOperation falls back to the raw key on purpose: BOT Chain has no
   * third-party bundler to take over, so without a fallback a relayer problem would
   * strand an agent that has already committed to a task. The fallback transacts as
   * the OWNER, which only matters for calls where the sender is the agent identity,
   * so `register` and `placeBid` are attempted as UserOperations and never silently
   * re-sent from the wrong address.
   */
  async send(contract, method, args, { value = 0n, identityCall = false } = {}) {
    if (!this.useAccount || !this.account) {
      const tx = await contract[method](...args, value ? { value } : {});
      return tx.wait();
    }
    const data = contract.interface.encodeFunctionData(method, args);
    const target = await contract.getAddress();
    try {
      const out = await sendUserOperation(this.ctx, {
        accountAddress: this.account,
        ownerSigner: this.wallet,
        relayer: this.ctx.signer(),
        calls: [{ to: target, value, data }],
      });
      if (out.success !== true) {
        // handleOps can succeed as a transaction while the inner call reverted.
        throw new Error(`UserOperation reverted (${out.userOpHash})`);
      }
      return out;
    } catch (e) {
      if (identityCall) throw e; // must come from the account; do not re-send as the key
      this.log(`UserOperation failed (${e.shortMessage || e.message}), retrying with the raw key`);
      const tx = await contract[method](...args, value ? { value } : {});
      return tx.wait();
    }
  }

  log(...a) {
    console.log(`[${this.ctx.id}/${this.cfg.name}]`, ...a);
  }

  /** Amount → on-chain units in this network's escrow asset. */
  units(n) {
    return ethers.parseUnits(String(n), this.ctx.asset.decimals);
  }

  /**
   * Gas check. An agent with no gas cannot register, bid or submit — without this
   * it would loop on failures forever, which is exactly the "agent stuck failing"
   * behaviour we must not ship. Reported once, re-checked every tick.
   */
  /** Balance of the asset budgets/stakes are denominated in. */
  async assetBalance() {
    return this.native
      ? this.ctx.provider.getBalance(this.address)
      : this.token.balanceOf(this.address);
  }

  async hasGas(reserve = 0n) {
    try {
      // In smart-account mode the relayer submits and is reimbursed from the
      // ACCOUNT's EntryPoint deposit, so that deposit is what must not run dry; the
      // owner key only signs and needs no gas at all.
      const bal = this.useAccount && this.account
        ? await accountOf(this.ctx, this.account).depositBalance()
        : await this.ctx.provider.getBalance(this.wallet.address);
      // Where stake and gas are the same coin, "has gas" must mean "has gas beyond
      // what's staked or about to be" — otherwise an agent stakes its last BOT and
      // can never pay to submit the work it just won.
      const floor = this.native ? reserve + GAS_RESERVE : 0n;
      const ok = bal > floor;
      if (!ok && !this.outOfGas) {
        this.outOfGas = true;
        this.log(
          `not enough ${this.ctx.gasSymbol} for gas (has ${ethers.formatEther(bal)}, needs > ${ethers.formatEther(floor)}), fund ${this.useAccount && this.account ? `${this.account}'s EntryPoint deposit` : this.wallet.address} to resume`,
        );
      }
      if (ok && this.outOfGas) {
        this.outOfGas = false;
        this.log("gas restored — resuming");
      }
      return ok;
    } catch {
      return true; // don't stall the swarm on a transient RPC failure
    }
  }

  /**
   * Mint this agent's ERC-8004 identity if the network has the registries and the
   * agent has no id yet.
   *
   * Called with the AGENT's own signer on purpose: the registry's `register` mints
   * to `msg.sender`, so minting from the verifier or the deployer would leave the
   * identity owned by an address that isn't the agent. Best-effort, because an
   * identity is portable reputation, not a precondition for earning.
   */
  async ensureErc8004Identity() {
    if (!erc8004Available(this.ctx)) return;
    try {
      // In smart-account mode the identity must belong to the ACCOUNT, which is the
      // address the market knows as this agent, so the mint goes through a
      // UserOperation rather than being signed by the owner key. That is also the
      // only way it can pay: in account mode the owner key deliberately holds no
      // gas, and minting from it failed with "insufficient funds" the first time.
      if (this.useAccount && this.account) {
        const existing = await agentIdOf(this.ctx, this.account);
        if (existing != null) {
          this.erc8004Id = existing;
          return;
        }
        const reg = identityContract(this.ctx, this.ctx.provider);
        const out = await this.send(reg, "register", [agentUriFor(this.account)], { identityCall: true });
        const id = parseRegisteredId(this.ctx, out?.receipt?.logs ?? out?.logs);
        if (id != null) {
          recordAgentId(this.ctx, this.account, id);
          this.erc8004Id = id;
          this.log(`minted ERC-8004 identity #${id} for the account`);
        }
        return;
      }
      const id = await ensureIdentity(this.ctx, this.wallet, {
        name: this.cfg.name,
        capabilities: (this.cfg.capabilities || []).join(","),
      });
      if (id != null) this.erc8004Id = id;
    } catch (e) {
      this.log(`ERC-8004 identity skipped: ${e.shortMessage || e.message}`);
    }
  }

  /**
   * Open the ERC-8004 validation request as the ACCOUNT, via a UserOperation. Only
   * the identity's owner may open one, and in account mode that owner is the
   * account, not the key.
   */
  async requestValidationViaAccount(taskId) {
    const validator = this.ctx.signer()?.address;
    if (!validator || !this.ctx.ADDR.erc8004Validation) return;
    const agentId = await agentIdOf(this.ctx, this.account);
    if (agentId == null) return;
    const requestHash = validationRequestHash(this.ctx, agentId, taskId);
    const reg = new ethers.Contract(
      this.ctx.ADDR.erc8004Validation,
      ["function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)"],
      this.ctx.provider,
    );
    await this.send(reg, "validationRequest", [validator, agentId, agentUriFor(this.account), requestHash], {
      identityCall: true,
    });
    this.log(`requested ERC-8004 validation of task ${String(taskId).slice(0, 10)}…`);
  }

  async ensureRegistered() {
    const info = await this.reg.agents(this.address);
    if (info.registered) {
      if (!info.online) {
        await this.send(this.reg, "restake", [0], { value: 0n, identityCall: true });
        this.log("came back online");
      }
      // An agent registered before ERC-8004 existed here still deserves an identity.
      await this.ensureErc8004Identity();
      return;
    }
    // Default stake: the network's own floor where it has one (native networks set
    // it at deploy time), else the ERC-20 registry's 100-unit constant.
    const defaultStake = this.ctx.minStakeWei
      ? Number(ethers.formatUnits(this.ctx.minStakeWei, this.ctx.asset.decimals))
      : 100;
    const stake = this.units(this.cfg.stake ?? defaultStake);
    const bal = await this.assetBalance();
    // On a native network the stake normally comes out of the same balance that pays
    // gas, so require enough for both. A smart account is the exception: its gas is
    // charged to its EntryPoint deposit (checked separately by hasGas), so reserving
    // gas out of its balance would refuse to stake an account that is perfectly
    // funded, which is exactly what happened to the first 4337 agent.
    const reserveGas = this.native && !(this.useAccount && this.account);
    const needed = reserveGas ? stake + GAS_RESERVE : stake;
    if (bal < needed) {
      this.log(
        `needs ${ethers.formatUnits(needed, this.ctx.asset.decimals)} ${this.ctx.asset.symbol} to stake${reserveGas ? " (incl. gas reserve)" : ""}, has ${ethers.formatUnits(bal, this.ctx.asset.decimals)}`,
      );
      return;
    }
    if (!this.native) {
      const allowance = await this.token.allowance(this.address, this.ctx.ADDR.agentRegistry);
      if (allowance < stake) await (await this.token.approve(this.ctx.ADDR.agentRegistry, stake)).wait();
    }
    // identityCall: registration MUST come from the agent's own identity, so it is
    // never retried from the owner key, which would register the wrong address.
    await this.send(
      this.reg,
      "register",
      [agentId(this.cfg.name, this.address), stake, this.cfg.name, (this.cfg.capabilities || []).join(",")],
      { value: this.native ? stake : 0n, identityCall: true },
    );
    this.log(`registered on-chain with ${this.cfg.stake ?? defaultStake} ${this.ctx.asset.symbol} stake`);
    await this.ensureErc8004Identity();
  }

  /** Does this agent want this task? Capability match is the core decision. */
  wants(meta) {
    if (!this.cfg.capabilities?.length) return true; // generalist
    return this.cfg.capabilities.includes(meta.taskType) || this.cfg.capabilities.includes("general");
  }

  async bidOn(taskId, meta) {
    if (this.seen.has(taskId)) return;
    if (await this.bid.auctionClosed(taskId)) return;
    const rep = Number(await this.reg.getReputation(this.address));
    if (rep < meta.minReputation) return;

    this.seen.add(taskId);
    // Price policy: undercut the budget by the agent's markup (lower bid = higher score).
    //
    // Rounded to the ASSET's precision, not to 2 decimals. `toFixed(2)` and a hard 0.01
    // floor are USDC-isms: on an 18-decimal coin a 0.01 BOT budget with a 0.85 markup rounds
    // straight back to 0.01, so every agent submits the identical bid and BidEngine's price
    // score (40% of the total) has nothing to discriminate on. Observed on mainnet: four
    // distinct markups, four identical 0.01 bids.
    const markup = this.cfg.markup ?? 0.85;
    const dp = this.ctx.asset.decimals >= 18 ? 6 : 2;
    const floor = 10 ** -dp;
    const bidAmount = Math.max(floor, +(meta.budgetUsdc * markup).toFixed(dp));
    const etaSeconds = 1800;
    try {
      await this.send(this.bid, "placeBid", [taskId, this.units(bidAmount), etaSeconds], { identityCall: true });
      this.log(`bid ${bidAmount} ${this.ctx.asset.symbol} on "${meta.title}" (#${taskId.slice(2, 10)})`);
      // Deliberately does NOT award. Closing the auction here is what made this a race
      // instead of a market: see BID_WINDOW_MS. The swarm tick closes it once the window has
      // passed and every agent has had its chance to bid.
    } catch (e) {
      this.log("bid skipped:", e.shortMessage || e.message);
    }
  }

  /** If we won and haven't delivered yet, do the work and trigger settlement. */
  async fulfilWins() {
    const logs = await this.ctx.queryLogsChunked(
      this.bid,
      this.bid.filters.BidAwarded(null, this.address),
      undefined,
      this.ctx.indexFromBlock ?? undefined,
    );
    for (const lg of logs) {
      const taskId = lg.args.taskId;
      if (this.handled.has(taskId)) continue;
      // Durable, so a restart does not reset the budget and resume paying for a task that
      // has already failed its limit.
      if (exhausted(this.ctx.chainId, taskId)) {
        this.handled.add(taskId);
        continue;
      }
      this.handled.add(taskId);
      // Declared outside the try because the catch reports on it. It was a `const` inside
      // the try, so the "already in progress" branch referenced an out-of-scope binding and
      // threw a ReferenceError instead of logging: the one branch meant to avoid a pointless
      // retry was the one that could not run.
      let meta = null;
      try {
        meta = await this.ctx.readTaskMeta(taskId);
        if (!meta) continue;
        // Optional: pay a sub-cent x402 nanopayment for an oracle quote first.
        // Only on networks with a Circle Gateway facilitator (Arc) — BOT Chain has
        // no Circle presence, so this is skipped rather than faked.
        const oracle = process.env.X402_PAY_FOR_ORACLE === "1" && this.ctx.supportsX402 ? process.env.X402_ORACLE_URL : null;
        if (oracle) {
          try {
            const { data } = await payForService(oracle, this.cfg.key);
            this.log(`x402 paid $0.01 for oracle → quote ${data?.usdcQuote ?? "?"}`);
          } catch (e) {
            this.log("x402 oracle pay skipped:", e.message);
          }
        }
        this.log(`won "${meta.title}" — producing deliverable…`);
        const { deliverable, gradeableText } = await produceWork(meta);
        // Sign so the backend can verify this submission really came from this
        // agent's own wallet (server/auth.js), not a third party impersonating
        // it (see docs/AUDIT_REPORT.md, Security #2).
        const signature = await this.wallet.signMessage(`polaris-deliverable:${taskId.toLowerCase()}`);
        await postJSON(`/api/deliverable`, this.ctx.id, {
          taskId,
          agentWallet: this.address,
          deliverable,
          // Only meaningful for a rendered file: the source text the verifier can
          // actually grade. The deliverable itself is still what gets hashed.
          gradeableText,
          signature,
        });
        // Open the ERC-8004 validation request BEFORE asking for a verdict. Under
        // the standard the agent asks for its own work to be validated and the
        // validator answers, and only an owner may open the request, so this has to
        // happen here with the agent's own key. The verifier answers it during
        // settlement. Best-effort: a missing request costs an attestation, never
        // the payment.
        if (erc8004Available(this.ctx)) {
          if (this.useAccount && this.account) {
            // The ACCOUNT owns the identity, so the request must come from it.
            await this.requestValidationViaAccount(taskId).catch(() => null);
          } else {
            await requestValidation(this.ctx, this.wallet, { taskId }).catch(() => null);
          }
        }
        const verdict = await postJSON(`/api/verify`, this.ctx.id, { taskId });
        // Not every 200 carries a verdict: the backend answers
        // `{status:"settled"}` with no score when the task was already settled on
        // chain. Printing that as "undefined/100 (FAIL)" was misleading, and worse,
        // the retry it triggered made the agent pay to regenerate a deliverable for
        // work that was already done and paid for.
        if (typeof verdict.score !== "number") {
          this.log(`verification returned no score for "${meta.title}" (${verdict.status || verdict.note || "no status"}); leaving it settled`);
        } else {
          this.log(`settled "${meta.title}" → ${verdict.score}/100 (${verdict.passed ? "PASS" : "FAIL"})`);
        }
        // Got all the way through, so the task owes nothing to the retry budget.
        clearFailures(this.ctx.chainId, taskId);
      } catch (e) {
        const msg = e.message || "";
        // "already in progress" is the backend deduplicating a concurrent verify, not
        // a failure. Retrying it re-runs the LLM for nothing, so keep the task
        // handled and let the next tick see the settled state.
        if (/already in progress/i.test(msg)) {
          this.log(`verification already running for "${meta?.title ?? taskId.slice(0, 10)}", waiting`);
          continue;
        }
        // A bounded retry, not an unbounded one. This used to clear `handled`
        // unconditionally, so a task that could never succeed was retried every tick and
        // paid for a fresh model call each time while staying pinned in ASSIGNED.
        const n = recordFailure(this.ctx.chainId, taskId, msg);
        if (n >= FULFIL_MAX_ATTEMPTS) {
          this.log(
            `giving up on ${taskId.slice(0, 10)} after ${n} attempts: ${msg}. ` +
              `Leaving it for the deadline reaper, which refunds the requester and slashes this agent.`,
          );
          // Stays in `handled`, so this process stops spending on it.
        } else {
          this.handled.delete(taskId); // retry next loop, within budget
          this.log(`fulfil error (attempt ${n}/${FULFIL_MAX_ATTEMPTS}):`, msg);
        }
      }
    }
  }
}

/** POST to our own API, always naming the network the work belongs to. */
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

async function postJSON(path, networkId, body) {
  const r = await fetch(`${API_URL}${path}?network=${encodeURIComponent(networkId)}`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ ...body, network: networkId }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `POST ${path} failed`);
  return r.json();
}

/**
 * Start the raw-key swarm for one network. Returns false when there's nothing to
 * run (no agents configured, or the network isn't deployed), so the caller can
 * report it rather than silently doing nothing.
 */
export async function startSwarm(networkId = DEFAULT_NETWORK) {
  if (!isDeployed(networkId)) {
    console.log(`[swarm:${networkId}] not deployed — swarm not started.`);
    return false;
  }
  const configs = agentsFor(networkId);
  if (configs.length === 0) return false;

  const ctx = getChainCtx(networkId);
  ctx.requireAddresses(["agentRegistry", "bidEngine", "taskRegistry", "verifierBridge"]);
  const taskReg = ctx.contract("taskRegistry", "taskRegistry");
  const agents = configs.map((c) => new Agent(c, ctx));

  console.log(`[swarm:${networkId}] starting with ${agents.length} agent(s) on ${getNetwork(networkId).label}`);
  for (const a of agents) {
    // Resolve the ERC-4337 account first where enabled: everything after this
    // (registry entry, bids, payouts) belongs to that address, not the owner key.
    await a.resolveIdentity().catch((e) => a.log("smart account unavailable:", e.shortMessage || e.message));
    if (await a.hasGas()) await a.ensureRegistered().catch((e) => a.log("register skipped:", e.shortMessage || e.message));
  }

  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a previous tick is still in flight — don't overlap
    ticking = true;
    try {
      const submitted = await ctx.queryLogsChunked(
        taskReg,
        taskReg.filters.TaskSubmitted(),
        undefined,
        ctx.indexFromBlock ?? undefined,
      );

      for (const lg of submitted) {
        const taskId = lg.args.taskId;
        const t = await taskReg.tasks(taskId);
        if (Number(t.status) !== 0) continue; // 0 = OPEN; skip assigned/settled
        if (t.deadline * 1000n < BigInt(Date.now())) continue; // expired
        const meta = await ctx.readTaskMeta(taskId);
        if (!meta) continue;

        // The auction's own clock, from on-chain data so every agent and every restart
        // agrees on it: 20 minutes from creation, clamped to whatever is left before the
        // deadline (a task due sooner than the window cannot wait the full window).
        const createdAtMs = Number(t.createdAt) * 1000;
        const deadlineMs = Number(t.deadline) * 1000;
        const windowMs = Math.min(BID_WINDOW_MS, Math.max(0, deadlineMs - createdAtMs));
        const windowClosed = Date.now() >= createdAtMs + windowMs;

        if (!windowClosed) {
          for (const a of agents) {
            // Never let an agent commit to work it can't pay the gas to submit.
            if (a.wants(meta) && (await a.hasGas())) await a.bidOn(taskId, meta);
          }
          continue;
        }

        // Window over: close it and let BidEngine pick on score. Idempotent — `awardBid`
        // guards on `auctionClosed`, so whoever gets there first just finalises the winner.
        // Done here rather than on a timer because a restart forgets a timer, and a task
        // left OPEN with bids and nothing to award it is one more way to get stuck.
        // Any agent may close an auction; pick one that can pay the gas.
        let closer = null;
        for (const a of agents) if (await a.hasGas()) { closer = a; break; }
        if (!closer) continue;
        try {
          await closer.send(closer.bid, "awardBid", [taskId]);
          closer.log(`bidding closed for "${meta.title}" — best bid awarded`);
        } catch (e) {
          const msg = e.shortMessage || e.message || "";
          // "No bids" is normal: nobody wanted it, and it stays OPEN until its deadline.
          if (!/Auction closed|No bids/i.test(msg)) closer.log("award skipped:", msg);
        }
      }
      for (const a of agents) if (await a.hasGas()) await a.fulfilWins();
    } catch (e) {
      console.error(`[swarm:${networkId}] tick error:`, e.message);
    } finally {
      ticking = false;
    }
  };

  await tick();
  // Deliberately NOT unref'd: when run directly (`npm run swarm`) this timer is
  // what keeps the process alive.
  setInterval(tick, POLL_MS);
  return true;
}

// Run directly (`npm run swarm`) → start Arc's swarm, matching the old behaviour.
// Imported by runtime.js → it decides which networks to start.
const isDirectRun = process.argv[1] && process.argv[1].endsWith("agent.js");
if (isDirectRun) {
  const networkId = process.env.SWARM_NETWORK || DEFAULT_NETWORK;
  startSwarm(networkId)
    .then((started) => {
      if (!started) {
        console.error(
          `No agents configured for ${networkId}. Set AGENTS_JSON${networkId === DEFAULT_NETWORK ? "" : `_${envKey(networkId)}`} in .env (see .env.example).`,
        );
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
