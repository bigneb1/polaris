/**
 * Post a task on-chain (requester side) to exercise the full Polaris loop:
 * approve USDC → submitTask (locks budget in escrow). The autonomous swarm then
 * bids, wins, does the work, and settles.
 *
 * Usage: node scripts/post-task.cjs            (uses defaults below)
 * Env:   DEPLOYER_PRIVATE_KEY, ARC_RPC_URL, VITE_CONTRACT_* (from contracts/.env or shell)
 */
const { ethers } = require("ethers");
require("dotenv").config();

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC = process.env.VITE_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const ESCROW = process.env.VITE_CONTRACT_USDC_ESCROW || "0x6718a657BAe49Fa44Fc84a99dB8a2A9E4D15854e";
const TASKREG = process.env.VITE_CONTRACT_TASK_REGISTRY || "0x9C12aa69B30c00DC799Db1e31139F86F317B6Afd";

const ERC20 = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
const TASKREG_ABI = ["function submitTask(bytes32 taskId, uint256 budgetUsdc, uint256 deadline, uint256 minReputation, string title, string description, string rubric, string taskType)"];

async function main() {
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(RPC));
  const usdc = new ethers.Contract(USDC, ERC20, wallet);
  const reg = new ethers.Contract(TASKREG, TASKREG_ABI, wallet);

  const budget = ethers.parseUnits(process.env.TASK_BUDGET || "2", 6);
  const taskId = ethers.hexlify(ethers.randomBytes(32));
  const deadline = Math.floor(Date.now() / 1000) + 2 * 86400;

  const title = process.env.TASK_TITLE || "Summarize what makes Arc Network suited to agent nanopayments";
  const description =
    process.env.TASK_DESC ||
    "Write a concise, accurate 120-180 word explainer of why Arc (Circle's stablecoin L1) is well suited to AI-agent nanopayments. Cover: USDC as native gas, sub-second deterministic finality, and predictable ~$0.01 fees.";
  const rubric =
    process.env.TASK_RUBRIC ||
    "Accurate on Arc/USDC facts (40). Covers native-USDC-gas, finality, and low fees (30). Concise 120-180 words (20). Clear, no fluff (10). Pass >= 70.";

  console.log("Requester:", wallet.address);
  console.log("Balance:", ethers.formatUnits(await usdc.balanceOf(wallet.address), 6), "USDC");
  console.log("Task:", taskId, "| budget", ethers.formatUnits(budget, 6), "USDC");

  const allowance = await usdc.allowance(wallet.address, ESCROW);
  if (allowance < budget) {
    console.log("approving escrow…");
    await (await usdc.approve(ESCROW, budget)).wait();
  }
  console.log("submitting task…");
  const tx = await reg.submitTask(taskId, budget, deadline, 0, title, description, rubric, "research");
  const rc = await tx.wait();
  console.log("✅ task posted in block", rc.blockNumber, "tx", rc.hash);
  console.log("   explorer: https://testnet.arcscan.app/tx/" + rc.hash);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
