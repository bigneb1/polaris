const hre = require("hardhat");
async function main() {
  const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
  const signer = process.env.VERIFIER_SIGNER_ADDRESS;
  // Treasury = RevenueRouter (protocol treasury), falls back to deployer.
  const treasury = process.env.TREASURY_ADDRESS || "0xe26f6beE50A181211291E903D9EA792a02C4b296";
  if (!signer) throw new Error("VERIFIER_SIGNER_ADDRESS not set");
  const [d] = await hre.ethers.getSigners();
  console.log("Deployer:", d.address, "| signer:", signer, "| treasury:", treasury);
  const dm = await hre.ethers.deployContract("DisputeManager", [usdc, signer, treasury]);
  await dm.waitForDeployment();
  const addr = await dm.getAddress();
  console.log("\n✅ DisputeManager v2 deployed:", addr);
  console.log("Verify:\n  npx hardhat verify --network arc_testnet", addr, usdc, signer, treasury);
}
main().catch((e) => { console.error(e); process.exit(1); });
