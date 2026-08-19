/**
 * Deploy the ERC-4337 account factory on a network that already has the canonical
 * EntryPoint, and record it in the deployment artifact.
 *
 * Separate from the market deploy on purpose: the factory has no dependency on any
 * Polaris contract, so it can be added (or replaced) without touching settlement.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/deploy-4337.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const NETWORK_IDS = { bot_testnet: "botchain-testnet", bot_mainnet: "botchain-mainnet" };

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    throw new Error(`Set CONFIRM_DEPLOY=${network.name} to confirm the target network.`);
  }
  const id = NETWORK_IDS[network.name];
  const file = path.join(__dirname, "..", "..", "deployments", id, "contracts.json");
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));

  // Refuse to deploy a factory pointed at an EntryPoint that isn't there: every
  // account it created would be permanently unusable.
  const code = await ethers.provider.getCode(ENTRY_POINT);
  if (code === "0x") throw new Error(`No EntryPoint at ${ENTRY_POINT} on ${network.name}.`);
  console.log(`EntryPoint v0.7 present at ${ENTRY_POINT} (${(code.length - 2) / 2} bytes)`);

  const factory = await ethers.deployContract("PolarisAccountFactory", [ENTRY_POINT]);
  await factory.waitForDeployment();
  const addr = await factory.getAddress();
  console.log(`PolarisAccountFactory     ${addr}`);

  artifact.contracts = { ...artifact.contracts, accountFactory: addr, entryPoint: ENTRY_POINT };
  artifact.erc4337UpdatedAtIso = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Artifact updated: ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
