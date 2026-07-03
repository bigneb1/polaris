const hre = require("hardhat");
async function main() {
  const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
  const agentRegistry = "0xEb27dBC89529Bab0365a635F29Ffc720Eb87C470"; // V4 AgentRegistry
  const signer = process.env.VERIFIER_SIGNER_ADDRESS;
  if (!signer) throw new Error("VERIFIER_SIGNER_ADDRESS not set");
  const [d] = await hre.ethers.getSigners();
  console.log("Deployer:", d.address);
  const rm = await hre.ethers.deployContract("RecurringMarket", [usdc, agentRegistry, signer]);
  await rm.waitForDeployment();
  const addr = await rm.getAddress();
  console.log("\n✅ RecurringMarket deployed:", addr);
  console.log("Verify:\n  npx hardhat verify --network arc_testnet", addr, usdc, agentRegistry, signer);
}
main().catch((e) => { console.error(e); process.exit(1); });
