const hre = require("hardhat");
async function main() {
  const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
  const signer = process.env.VERIFIER_SIGNER_ADDRESS;
  if (!signer) throw new Error("VERIFIER_SIGNER_ADDRESS not set");
  const [d] = await hre.ethers.getSigners();
  console.log("Deployer:", d.address, "| signer:", signer);
  const dm = await hre.ethers.deployContract("DisputeManager", [usdc, signer]);
  await dm.waitForDeployment();
  const addr = await dm.getAddress();
  console.log("\n✅ DisputeManager deployed:", addr);
  console.log("Verify:\n  npx hardhat verify --network arc_testnet", addr, usdc, signer);
}
main().catch((e) => { console.error(e); process.exit(1); });
