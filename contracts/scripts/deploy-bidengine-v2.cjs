/**
 * Deploy the fairness-lottery BidEngine and rewire the live TaskRegistry to it.
 *
 * The deployed AgentRegistry + TaskRegistry are REUSED (agents stay registered,
 * tasks stay escrowed). Only the auction's scoring engine is swapped:
 *   1. deploy new BidEngine(agentRegistry)
 *   2. newBidEngine.setTaskRegistry(taskRegistry)   — lets TaskRegistry.reopenAuction call back
 *   3. taskRegistry.setBidEngine(newBidEngine)      — authorizes it to assignAgent
 *
 * In-flight ASSIGNED work is unaffected (it settles via VerifierBridge). Any task
 * still OPEN must be re-bid on the new engine — the swarm does this automatically
 * once restarted with the new address (its per-task "seen" set resets on boot).
 */
const { ethers, run } = require("hardhat");

const AGENT_REG = "0xEb27dBC89529Bab0365a635F29Ffc720Eb87C470";
const TASK_REG = "0xe3ad52025F740599A5b02ffD394514fBD3E80F9C";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);

  const bidEngine = await ethers.deployContract("BidEngine", [AGENT_REG]);
  await bidEngine.waitForDeployment();
  const addr = await bidEngine.getAddress();
  console.log("new BidEngine:", addr);

  await (await bidEngine.setTaskRegistry(TASK_REG)).wait();
  console.log("  setTaskRegistry ->", TASK_REG);

  const taskReg = await ethers.getContractAt("TaskRegistry", TASK_REG);
  await (await taskReg.setBidEngine(addr)).wait();
  console.log("  TaskRegistry.setBidEngine ->", addr);

  // sanity: confirm the rewire took
  console.log("  TaskRegistry.bidEngine now:", await taskReg.bidEngine());

  console.log("\nUpdate these:");
  console.log(`  server/.env       VITE_CONTRACT_BID_ENGINE=${addr}`);
  console.log(`  src/lib/contracts.ts  bidEngine: "${addr}"`);

  try {
    await run("verify:verify", { address: addr, constructorArguments: [AGENT_REG] });
    console.log("verified on Blockscout");
  } catch (e) {
    console.log("verify skipped:", e.message.split("\n")[0]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
