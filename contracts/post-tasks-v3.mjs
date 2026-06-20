import { ethers } from "ethers";
import fs from "fs";

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

const TASKS = [
  ["research", "Research: Arc vs other stablecoin L1s", "Compare Arc to 3 other stablecoin-oriented chains on gas model, finality, and USDC support.", "Covers >=3 chains; names gas model + finality each; ends with a comparison table.", 3],
  ["analysis", "Analyze: reverse-auction bidding for agent tasks", "Explain why a price+reputation+speed reverse auction is a good fit for an autonomous agent marketplace.", "Defines the 3 factors; gives a worked scoring example; states one risk and one mitigation.", 3],
  ["writing", "Write: 4-tweet thread on onchain agent payments", "Write a 4-tweet thread explaining agents that hire, verify and pay each other in USDC on Arc.", "Exactly 4 tweets, each <280 chars; tweet 1 hooks; tweet 4 has a call to action; no emojis.", 2],
  ["summarization", "Summarize: how reopenTask returns work to the market", "Summarize how a rejected (but not slashed) task is returned to the market for re-bidding.", "Under 150 words; covers reopen, escrow staying locked, feedback to agents, and the slash condition.", 2],
];

async function main() {
  const total = TASKS.reduce((s, t) => s + t[4], 0);
  console.log("requester", w.address, "USDC", ethers.formatUnits(await usdc.balanceOf(w.address), 6), "| posting", TASKS.length, "tasks total", total, "USDC");
  if ((await usdc.allowance(w.address, ESCROW)) < U(total)) {
    const tx = await usdc.approve(ESCROW, U(total)); await tx.wait(); console.log("approved", tx.hash);
  }
  let nonce = await p.getTransactionCount(w.address);
  const deadline = Math.floor(Date.now() / 1000) + 2 * 86400;
  const posted = [];
  for (let i = 0; i < TASKS.length; i++) {
    const [tt, title, desc, rubric, budget] = TASKS[i];
    const taskId = ethers.hexlify(ethers.randomBytes(32));
    try {
      const tx = await taskReg.submitTask(taskId, U(budget), deadline, 70, title, desc, rubric, tt, { nonce: nonce++ });
      await tx.wait(); posted.push(taskId);
      console.log(`  [${i + 1}/${TASKS.length}] ${title} (${budget} USDC) -> ${tx.hash}`);
    } catch (e) { nonce--; console.log(`  FAILED ${title}: ${e.shortMessage || e.message}`); }
  }
  console.log(`Posted ${posted.length}/${TASKS.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
