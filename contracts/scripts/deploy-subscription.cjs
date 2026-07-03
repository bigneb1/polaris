/* Deploy SubscriptionManager (Phase A — recurring tasks) to Arc testnet.
 *
 *   npx hardhat run scripts/deploy-subscription.cjs --network arc_testnet
 *
 * Self-contained: it custodies its own USDC and reuses the existing verifier
 * signer, so it needs no wiring into the live V4 contracts. After deploy, set
 *   VITE_CONTRACT_SUBSCRIPTION_MANAGER=<addr>
 * on Vercel (frontend) and Railway (runtime), then verify on Arcscan. */
const hre = require("hardhat");

async function main() {
  const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
  const signer = process.env.VERIFIER_SIGNER_ADDRESS;
  if (!signer) throw new Error("VERIFIER_SIGNER_ADDRESS not set in contracts/.env");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("USDC:    ", usdc);
  console.log("Signer:  ", signer);

  const sm = await hre.ethers.deployContract("SubscriptionManager", [usdc, signer]);
  await sm.waitForDeployment();
  const addr = await sm.getAddress();
  console.log("\n✅ SubscriptionManager deployed:", addr);
  console.log("\nVerify:\n  npx hardhat verify --network arc_testnet", addr, usdc, signer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
