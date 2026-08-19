/**
 * Point the live smart-account agent at an account from the CURRENT factory and fund
 * it, after the factory gained `onERC721Received` (without which the account cannot
 * be minted its ERC-8004 identity, because an identity is an ERC-721 issued with
 * _safeMint).
 *
 * The owner key is unchanged, so the runtime needs no config change: the account
 * address is derived from (owner, salt) against whichever factory the artifact names.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet OWNER=0x… npx hardhat run scripts/refund-4337-agent.cjs --network bot_testnet
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
  if (process.env.CONFIRM_DEPLOY !== network.name) throw new Error(`Set CONFIRM_DEPLOY=${network.name}.`);
  const owner = process.env.OWNER;
  if (!owner) throw new Error("Set OWNER to the agent's owner key address.");

  const file = path.join(__dirname, "..", "..", "deployments", "botchain-testnet", "contracts.json");
  const { contracts: c, minStakeWei } = JSON.parse(fs.readFileSync(file, "utf8"));
  const stake = BigInt(minStakeWei);
  const [funder] = await ethers.getSigners();

  const factory = new ethers.Contract(c.accountFactory, FACTORY_ABI, funder);
  // Explicit signature: ethers' BaseContract.getAddress() shadows the Solidity one.
  const account = await factory["getAddress(address,uint256)"](owner, 0);
  console.log(`factory ${c.accountFactory}`);
  console.log(`owner   ${owner}`);
  console.log(`account ${account}`);

  if ((await ethers.provider.getCode(account)) === "0x") {
    await (await factory.createAccount(owner, 0)).wait();
    console.log("  deployed");
  } else {
    console.log("  already deployed");
  }

  // Stake comes from the account's balance; gas from its EntryPoint deposit.
  const want = stake + ethers.parseEther("0.01");
  const have = await ethers.provider.getBalance(account);
  if (have < want) {
    await (await funder.sendTransaction({ to: account, value: want - have })).wait();
  }
  const ep = new ethers.Contract(c.entryPoint, EP_ABI, funder);
  const wantDeposit = ethers.parseEther("0.08");
  const haveDeposit = await ep.balanceOf(account);
  if (haveDeposit < wantDeposit) {
    await (await ep.depositTo(account, { value: wantDeposit - haveDeposit })).wait();
  }
  console.log(`  balance ${ethers.formatEther(await ethers.provider.getBalance(account))} BOT`);
  console.log(`  deposit ${ethers.formatEther(await ep.balanceOf(account))} BOT`);
  console.log(`\nfunder left with ${ethers.formatEther(await ethers.provider.getBalance(funder.address))} BOT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
