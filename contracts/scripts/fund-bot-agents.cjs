/**
 * Create and fund two BOT Chain swarm agents, then print the AGENTS_JSON the
 * runtime needs.
 *
 * One agent runs on a raw key and one through an ERC-4337 smart account, on purpose:
 * that way the live market exercises both paths, and if the relayer or EntryPoint
 * ever misbehaves the raw-key agent still trades and the difference is obvious.
 *
 * Funding per agent covers the stake (0.02), the gas to register and bid, and a
 * reserve so an agent never commits to work it cannot pay to submit. The 4337
 * agent's gas comes from its account's EntryPoint deposit instead, so its owner key
 * needs almost nothing while the ACCOUNT needs the stake.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/fund-bot-agents.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const FACTORY_ABI = [
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
];
const EP_ABI = ["function depositTo(address account) payable", "function balanceOf(address) view returns (uint256)"];

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    throw new Error(`Set CONFIRM_DEPLOY=${network.name} to confirm the target network.`);
  }
  const file = path.join(__dirname, "..", "..", "deployments", "botchain-testnet", "contracts.json");
  const { contracts: c, minStakeWei } = JSON.parse(fs.readFileSync(file, "utf8"));
  const stake = BigInt(minStakeWei);
  const [funder] = await ethers.getSigners();

  const GAS_RESERVE = ethers.parseEther("0.08"); // stake and gas are the same coin here
  const DEPOSIT = ethers.parseEther("0.06"); // EntryPoint prefund for the 4337 agent

  console.log(`funder ${funder.address}, balance ${ethers.formatEther(await ethers.provider.getBalance(funder.address))} BOT`);
  console.log(`stake floor ${ethers.formatEther(stake)} BOT\n`);

  const out = [];

  // ── raw-key agent ─────────────────────────────────────────────────────────
  const raw = ethers.Wallet.createRandom();
  const rawNeeds = stake + GAS_RESERVE;
  await (await funder.sendTransaction({ to: raw.address, value: rawNeeds })).wait();
  console.log(`raw-key agent   ${raw.address} funded ${ethers.formatEther(rawNeeds)} BOT`);
  out.push({ name: "Bohr-Research", key: raw.privateKey, capabilities: ["research", "analysis", "summarization"] });

  // ── ERC-4337 agent: the ACCOUNT holds the stake, its deposit pays gas ─────
  const owner = ethers.Wallet.createRandom();
  const factory = new ethers.Contract(c.accountFactory, FACTORY_ABI, funder);
  // Explicit signature: ethers' BaseContract.getAddress() shadows the Solidity one.
  const account = await factory["getAddress(address,uint256)"](owner.address, 0);
  if ((await ethers.provider.getCode(account)) === "0x") {
    await (await factory.createAccount(owner.address, 0)).wait();
  }
  await (await funder.sendTransaction({ to: account, value: stake + ethers.parseEther("0.01") })).wait();
  const ep = new ethers.Contract(c.entryPoint, EP_ABI, funder);
  await (await ep.depositTo(account, { value: DEPOSIT })).wait();
  console.log(`4337 agent      account ${account}`);
  console.log(`                owner   ${owner.address}`);
  console.log(`                balance ${ethers.formatEther(await ethers.provider.getBalance(account))} BOT, deposit ${ethers.formatEther(await ep.balanceOf(account))} BOT`);
  out.push({ name: "Bohr-Writer", key: owner.privateKey, capabilities: ["writing", "code", "general"], smartAccount: true });

  console.log(`\nfunder left with ${ethers.formatEther(await ethers.provider.getBalance(funder.address))} BOT`);
  console.log("\nAGENTS_JSON_BOTCHAIN_TESTNET=");
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
