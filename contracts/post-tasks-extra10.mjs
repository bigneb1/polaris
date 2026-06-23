import { ethers } from "ethers";
import fs from "fs";

// Appends 10 tasks across 10 distinct categories/capabilities. Does NOT touch
// or clear any existing tasks — each submitTask just adds a new escrowed task.
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const RPC = env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const pk = env.DEPLOYER_PRIVATE_KEY || env.PRIVATE_KEY;
const USDC = "0x3600000000000000000000000000000000000000";
const ESCROW = "0xE9955f2A7fEcFC47844a5cDbbF39f424e2917c74";
const TASKREG = "0xe3ad52025F740599A5b02ffD394514fBD3E80F9C";

const p = new ethers.JsonRpcProvider(RPC, 5042002);
const w = new ethers.Wallet(pk, p);
const usdc = new ethers.Contract(USDC, ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"], w);
const taskReg = new ethers.Contract(TASKREG, ["function submitTask(bytes32,uint256,uint256,uint256,string,string,string,string)"], w);
const U = (n) => ethers.parseUnits(String(n), 6);

// [taskType, title, description, rubric, budgetUSDC, minRep]
const TASKS = [
  ["research", "Research: USDC adoption across L2s in 2026", "Survey where USDC liquidity sits across major L2s and what's driving migration between them.", "Names >=4 L2s with rough TVL/volume; cites 2+ sources; ends with a ranked takeaway.", 4, 70],
  ["analysis", "Analyze: failure modes of reverse-auction agent markets", "Identify how a price+reputation+speed reverse auction can be gamed by adversarial agents.", "Lists >=3 distinct attack vectors; gives a mitigation per vector; flags the worst one.", 4, 70],
  ["summarization", "Summarize: the Polaris escrow + releaseSplit flow", "Explain how funds lock on task creation and how releaseSplit pays the agent and refunds the requester.", "Under 150 words; covers lock, winning bid, agent payout, requester refund, reject path.", 2, 60],
  ["writing", "Write: 5-tweet thread on agents paying agents in USDC", "A thread explaining autonomous agents that hire, verify and pay each other on Arc.", "Exactly 5 tweets, each <280 chars; tweet 1 hooks; last has a CTA; no emojis.", 3, 60],
  ["translation", "Translate: Polaris one-pager into Spanish", "Translate a provided 200-word product one-pager into natural, fluent Spanish.", "Preserves meaning and tone; keeps product names in English; reads natively, not literal.", 3, 60],
  ["code", "Code: TypeScript helper to format USDC (6dp) amounts", "Write a pure TS function formatUsdc(bigint) -> string with thousands separators and 2dp display.", "Compiles; handles 0, large values, and rounding; includes 3 example assertions.", 4, 70],
  ["design", "Design: dark-theme empty-state for the task market", "Propose copy + layout for the 'no tasks yet' empty state matching Polaris's dark UI.", "Gives headline, subtext, and one CTA; explains color/spacing choices in 3 bullets.", 3, 50],
  ["data-labeling", "Data-labeling: classify 20 sample tasks by category", "Label a provided list of 20 task titles into the 7 Polaris categories.", "All 20 labeled; uses only valid categories; flags any ambiguous ones with a reason.", 2, 50],
  ["general", "General: draft a go-to-market checklist for the hackathon demo", "Produce a pre-demo checklist covering contracts, swarm, frontend, and a 2-min script.", "At least 10 concrete checklist items grouped by area; ends with a 2-minute demo script.", 3, 50],
  ["review", "Review: audit the reopenTask logic for edge cases", "Review how reopenTask returns a rejected task to the market and spot any edge cases.", "Names >=3 edge cases (e.g. deadline passed, double reopen, escrow state); verdict per case.", 4, 70],
];

async function main() {
  const total = TASKS.reduce((s, t) => s + t[4], 0);
  const bal = ethers.formatUnits(await usdc.balanceOf(w.address), 6);
  console.log("requester", w.address, "| USDC balance", bal, "| posting", TASKS.length, "tasks, total", total, "USDC");
  const allowance = await usdc.allowance(w.address, ESCROW);
  if (allowance < U(total)) {
    const tx = await usdc.approve(ESCROW, U(total * 4)); await tx.wait();
    console.log("approved escrow ->", tx.hash);
  }
  let nonce = await p.getTransactionCount(w.address);
  const deadline = Math.floor(Date.now() / 1000) + 2 * 86400; // 2 days
  const posted = [];
  for (let i = 0; i < TASKS.length; i++) {
    const [tt, title, desc, rubric, budget, minRep] = TASKS[i];
    const taskId = ethers.hexlify(ethers.randomBytes(32));
    try {
      const tx = await taskReg.submitTask(taskId, U(budget), deadline, minRep, title, desc, rubric, tt, { nonce: nonce++ });
      await tx.wait(); posted.push(taskId);
      console.log(`  [${i + 1}/${TASKS.length}] (${tt}) ${title} — ${budget} USDC -> ${tx.hash}`);
    } catch (e) { nonce--; console.log(`  FAILED (${tt}) ${title}: ${e.shortMessage || e.message}`); }
  }
  console.log(`\nPosted ${posted.length}/${TASKS.length} tasks across ${new Set(TASKS.map((t) => t[0])).size} distinct categories.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
