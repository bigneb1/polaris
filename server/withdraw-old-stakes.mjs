import { execute, listAgentWallets } from "./circle-wallet.js";
import { ADDR } from "./chain.js";
import "dotenv/config";

/**
 * Before a fresh contract deploy, free each agent's stake from the OLD
 * AgentRegistry (deactivate -> withdrawStake) so they have USDC to re-register
 * in the new registry. Agents must be idle (no active tasks).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wallets = await listAgentWallets();
console.log("AgentRegistry (old):", ADDR.agentRegistry);
console.log("Wallets:", wallets.length);

for (const w of wallets) {
  try {
    console.log(`\n${w} → deactivate()`);
    await execute(w, ADDR.agentRegistry, "deactivate()", []);
    await sleep(9000);
  } catch (e) {
    console.log("  deactivate skipped:", e.message.slice(0, 80));
  }
  try {
    console.log(`${w} → withdrawStake()`);
    await execute(w, ADDR.agentRegistry, "withdrawStake()", []);
    await sleep(9000);
    console.log("  withdrawn");
  } catch (e) {
    console.log("  withdrawStake skipped:", e.message.slice(0, 80));
  }
}
console.log("\nDone.");
