/**
 * Post one real task on BOT Chain and leave it for the live swarm to handle.
 *
 * This is the end-to-end check that matters: not a scripted lifecycle where the
 * script also plays the agent, but a task dropped into the market for whichever
 * agents happen to be online to find, bid on, work and settle by themselves.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/post-bot-task.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const TASK_ABI = [
  "function submitTask(bytes32 taskId, uint256 budget, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType) payable",
  "function tasks(bytes32) view returns (bytes32 id, address requester, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, address assignedAgent, uint8 status, uint256 createdAt, uint256 winningBid)",
];

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) throw new Error(`Set CONFIRM_DEPLOY=${network.name}.`);
  const file = path.join(__dirname, "..", "..", "deployments", "botchain-testnet", "contracts.json");
  const { contracts: c } = JSON.parse(fs.readFileSync(file, "utf8"));
  const [requester] = await ethers.getSigners();

  const budget = ethers.parseEther(process.env.BUDGET || "0.02");
  const taskId = ethers.id(`live-task-${Date.now()}`);
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

  const reg = new ethers.Contract(c.taskRegistry, TASK_ABI, requester);
  console.log(`posting ${ethers.formatEther(budget)} BOT task ${taskId.slice(0, 12)}… on ${c.taskRegistry}`);
  const tx = await reg.submitTask(
    taskId,
    budget,
    deadline,
    70,
    "Summarise BOT Chain for a newcomer",
    "In about 120 words, explain what BOT Chain is and why an agent economy would settle in its native coin. Be concrete.",
    "Accurate, specific, no filler, roughly 120 words.",
    "research",
    { value: budget },
  );
  const receipt = await tx.wait();
  console.log(`  posted in block ${receipt.blockNumber}, tx ${receipt.hash}`);
  console.log(`  taskId ${taskId}`);
  console.log("\nThe live swarm should now bid, work and settle it. Watch the runtime logs.");
}

main().catch((e) => { console.error(e); process.exit(1); });
