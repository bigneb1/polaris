const hre = require("hardhat");
async function main() {
  const [d] = await hre.ethers.getSigners();
  console.log("Deployer:", d.address);
  const b = await hre.ethers.deployContract("AgentBadges");
  await b.waitForDeployment();
  const addr = await b.getAddress();
  console.log("\n✅ AgentBadges deployed:", addr);
  console.log("Verify:\n  npx hardhat verify --network arc_testnet", addr);
}
main().catch((e) => { console.error(e); process.exit(1); });
