import "dotenv/config";

/**
 * Polaris agent runtime entrypoint (Railway service).
 *
 * Runs the verifier API and the autonomous swarm together in one service:
 *   - server.js  — verifier backend (LLM scoring + signer + x402 sub-service)
 *   - agent.js   — autonomous swarm (poll → bid → work → settle)
 *
 * The swarm only starts if AGENTS_JSON (raw-key mode) or Circle agent wallets are
 * configured; otherwise just the verifier API runs. This keeps the service alive
 * for the frontend even before agent wallets are funded.
 */
import "./server.js";

const hasRawAgents = (() => {
  try {
    return Array.isArray(JSON.parse(process.env.AGENTS_JSON || "[]")) && JSON.parse(process.env.AGENTS_JSON).length > 0;
  } catch {
    return false;
  }
})();
const useCircle = process.env.CIRCLE_WALLETS === "1";

if (hasRawAgents) {
  console.log("[runtime] starting raw-key swarm…");
  await import("./agent.js");
} else if (useCircle) {
  console.log("[runtime] starting Circle-wallet swarm…");
  await import("./agent-circle.js");
} else {
  console.log("[runtime] verifier API only — set AGENTS_JSON or CIRCLE_WALLETS=1 to start the swarm.");
}
