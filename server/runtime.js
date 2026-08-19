import "dotenv/config";

/**
 * Polaris agent runtime entrypoint (Railway service).
 *
 * Runs the verifier API and the autonomous swarms together in one service:
 *   - server.js  — verifier backend (LLM scoring + signer + x402 sub-service)
 *   - agent.js / agent-circle.js — autonomous swarms (poll → bid → work → settle)
 *
 * MULTI-CHAIN: one process serves every network listed in `SWARM_NETWORKS`
 * (default: Arc only). Each network gets its own schedulers and its own swarm,
 * with its own contracts, wallets and gas token. A network whose contracts aren't
 * deployed is skipped with a log line rather than started against another chain's
 * addresses.
 *
 *   SWARM_NETWORKS=arc-testnet,botchain-testnet
 *
 * Arc keeps its Circle MPC agent-wallet swarm (`CIRCLE_WALLETS=1`); BOT Chain uses
 * the raw-key swarm, since Circle has no BOT Chain support.
 */
import "./server.js";
import { activeNetworkIds, getNetwork } from "./networks.js";
import { startScheduler } from "./subscriptions.js";
import { startHostedRuntime } from "./hosted.js";
import { startRecurringMarket } from "./recurring.js";
import { startDisputeResolver } from "./disputes.js";
import { startReaper } from "./reaper.js";
import { startSwarm } from "./agent.js";

const networks = activeNetworkIds();
console.log(`[runtime] networks: ${networks.join(", ") || "(none)"}`);

for (const id of networks) {
  // Recurring-task scheduler runs alongside the verifier (needs the signer key).
  startScheduler(id);
  // Recurring-market scheduler: closes auctions + delivers awarded plans on schedule.
  startRecurringMarket(id);
  // Dispute auto-resolver: settles any dispute the client didn't finish resolving.
  startDisputeResolver(id);
  // Deadline enforcement. Every other service here advances work that is going well; this is
  // the one that guarantees work which is NOT going well still reaches a terminal state
  // instead of pinning a task in ASSIGNED and the budget in escrow.
  startReaper(id);
  // Hosted persona agents (Phase B) — runs user-registered personas server-side.
  if (process.env.HOSTED_AGENTS === "1") startHostedRuntime(id);
}

for (const id of networks) {
  const net = getNetwork(id);
  // Raw-key swarm first: it's the only mode BOT Chain supports, and Arc can use
  // it too when AGENTS_JSON is set.
  const rawStarted = await startSwarm(id);
  if (rawStarted) continue;

  if (net.swarmMode === "circle" && process.env.CIRCLE_WALLETS === "1") {
    // Arc's Circle MPC agent-wallet swarm. Self-starting module, Arc-bound.
    console.log(`[runtime] starting Circle-wallet swarm for ${id}…`);
    await import("./agent-circle.js");
    continue;
  }

  const hint =
    net.swarmMode === "circle"
      ? "set AGENTS_JSON or CIRCLE_WALLETS=1"
      : `set AGENTS_JSON_${id.replace(/-/g, "_").toUpperCase()}`;
  console.log(`[runtime] ${id}: verifier only — no swarm configured (${hint}).`);
}
