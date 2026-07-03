import { ethers } from "ethers";
import fs from "fs";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const RPC = env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const pk = env.PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY;
const USDC = "0x3600000000000000000000000000000000000000";
const ESCROW = env.VITE_CONTRACT_USDC_ESCROW || "0x2256D1F95f59DA5C23F2D8B18e138e339171C76E";
const TASKREG = env.VITE_CONTRACT_TASK_REGISTRY || "0x1cc2ac9d45c7B1d261C05df5bf16E778B93DAA35";

const p = new ethers.JsonRpcProvider(RPC, 5042002);
const w = new ethers.Wallet(pk, p);

const usdc = new ethers.Contract(USDC, [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
], w);

const taskReg = new ethers.Contract(TASKREG, [
  "function submitTask(bytes32,uint256,uint256,uint256,string,string,string,string) external",
], w);

const U = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 3600;

// 15 real tasks across the agent capability mix (research/analysis/writing/code/summarization/general).
const TASKS = [
  ["research", "Research: Stablecoin L1 landscape 2026", "Survey the major stablecoin-native L1s and payment chains (Arc, and peers). Compare consensus, gas-token model, finality, and target use cases.", "Covers at least 4 chains; names consensus + gas model for each; cites concrete finality numbers; ends with a comparison table.", 3],
  ["analysis", "Analyze: USDC as a native gas token tradeoffs", "Explain the pros and cons of using USDC as the native gas token of an L1 versus a separate volatile gas asset.", "Lists >=4 pros and >=4 cons; addresses fee predictability, UX, and validator economics; gives a clear recommendation.", 3],
  ["writing", "Write: Landing-page hero copy for an agent marketplace", "Write punchy hero copy (headline + subhead + 3 bullet value props) for an autonomous AI-agent task marketplace settled in USDC.", "One headline under 10 words; subhead under 25 words; exactly 3 benefit bullets; tone confident, not hypey.", 2],
  ["code", "Code: USDC transfer helper in TypeScript (viem)", "Write a TypeScript function using viem that sends an ERC-20 USDC transfer and waits for the receipt, with input validation.", "Compiles conceptually; validates address + amount; uses 6-decimal parsing; returns the tx hash; includes a short usage example.", 4],
  ["summarization", "Summarize: How onchain escrow protects task payments", "Summarize how an escrow contract that locks a requester's budget and releases on a passing verdict protects both sides of a task market.", "Under 200 words; covers lock, release, refund, and slash paths; plain language a non-engineer understands.", 2],
  ["research", "Research: x402 and agent micropayments", "Research the x402 payment standard and how it enables pay-per-call micropayments between autonomous agents.", "Explains the 402 flow; gives a concrete agent-to-agent example; notes settlement asset + batching; cites how Circle fits.", 3],
  ["analysis", "Analyze: Reputation-staking vs pure-stake agent markets", "Analyze the design tradeoffs of combining a USDC stake with an evolving reputation score for ranking agents, versus stake alone.", "Defines both models; covers sybil resistance, cold-start, and slashing incentives; states which fits a task market and why.", 3],
  ["writing", "Write: A 5-tweet thread explaining Polaris", "Write a 5-tweet thread explaining an autonomous agent task economy where agents hire, verify, and pay each other in USDC onchain.", "Exactly 5 tweets; each under 280 chars; tweet 1 hooks; tweet 5 has a clear call to action; no emojis.", 2],
  ["code", "Code: keccak256 task-id helper", "Write a small TypeScript helper that derives a deterministic bytes32 task id from a title and a nonce, and a random one as fallback.", "Uses keccak256 over encoded inputs; returns a 0x-prefixed 32-byte hex; includes the random fallback; has a test example.", 3],
  ["summarization", "Summarize: Deadline slashing for accountability", "Summarize why letting anyone slash an assigned agent that misses its deadline keeps an open task market honest.", "Under 180 words; explains who can call it, what happens to the stake, and why permissionless slashing matters.", 2],
  ["research", "Research: Trusted execution environments for oracle settlement", "Research how TEEs (AWS Nitro, Intel SGX) can host an offchain verifier so settlement verdicts are tamper-resistant.", "Explains attestation; describes binding code measurement to a signing key; notes the onchain verification step; lists 2 risks.", 4],
  ["analysis", "Analyze: Pricing strategy for autonomous bidding agents", "Analyze how an autonomous agent should price its bids (as a markup/discount on the task budget) to win work while staying profitable.", "Gives a concrete pricing rule; accounts for reputation, competition, and gas; includes a worked numeric example.", 3],
  ["writing", "Write: Plain-English explainer of gasless smart accounts", "Write a short explainer of how passkey-based smart-account wallets let users transact without holding a separate gas token.", "Under 250 words; explains paymaster sponsorship; no jargon left undefined; ends with one concrete user benefit.", 2],
  ["general", "General: Onboarding checklist for a new agent operator", "Produce a step-by-step checklist for someone who wants to run their own autonomous agent on the marketplace.", "Ordered steps; covers wallet, stake, capabilities, going online, and monitoring; >=7 actionable items.", 2],
  ["code", "Code: Poll-and-bid loop pseudocode", "Write clear pseudocode for an agent loop that polls open tasks, decides whether to bid, places a bid, and fulfils wins.", "Shows the poll interval, the want/skip decision, the bid + award calls, and the produce-then-verify step; readable structure.", 3],
];

async function main() {
  const bal = await usdc.balanceOf(w.address);
  const total = TASKS.reduce((s, t) => s + t[4], 0);
  console.log(`Requester ${w.address}`);
  console.log(`USDC balance: ${ethers.formatUnits(bal, 6)} | total budgets: ${total} USDC (gas also paid in USDC)`);

  // Approve escrow once for the full amount + headroom.
  const need = U(total);
  const cur = await usdc.allowance(w.address, ESCROW);
  if (cur < need) {
    console.log("approving escrow for", total, "USDC...");
    const tx = await usdc.approve(ESCROW, need);
    await tx.wait();
    console.log("approved", tx.hash);
  }

  let nonce = await p.getTransactionCount(w.address);
  const deadline = Math.floor(Date.now() / 1000) + 3 * DAY;
  const posted = [];
  for (let i = 0; i < TASKS.length; i++) {
    const [taskType, title, description, rubric, budget] = TASKS[i];
    const taskId = ethers.hexlify(ethers.randomBytes(32));
    try {
      const tx = await taskReg.submitTask(
        taskId, U(budget), deadline, 70, title, description, rubric, taskType,
        { nonce: nonce++ },
      );
      await tx.wait();
      posted.push({ taskId, title, budget });
      console.log(`  [${i + 1}/15] ${title} (${budget} USDC) -> ${tx.hash}`);
    } catch (e) {
      nonce--; // tx didn't consume the nonce
      console.log(`  [${i + 1}/15] FAILED ${title}: ${e.shortMessage || e.message}`);
      if ((e.shortMessage || e.message || "").toLowerCase().includes("insufficient")) {
        console.log("  Out of funds — stopping early.");
        break;
      }
    }
  }
  console.log(`\nPosted ${posted.length}/15 tasks.`);
  fs.writeFileSync("posted-tasks.json", JSON.stringify(posted, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
