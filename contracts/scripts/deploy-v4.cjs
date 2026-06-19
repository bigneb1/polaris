/**
 * V4 partial deploy — adds bid-refund split (agent paid the winning bid, requester
 * refunded the rest). Only USDCEscrow + TaskRegistry + VerifierBridge change; the
 * V3 AgentRegistry + BidEngine + RevenueRouter are REUSED so agents stay registered.
 */
const { ethers } = require("hardhat");

const USDC = "0x3600000000000000000000000000000000000000";
// Reused V3 contracts (unchanged):
const AGENT_REG = "0xEb27dBC89529Bab0365a635F29Ffc720Eb87C470";
const BID_ENGINE = "0x5A1D8e1eb034494849e2846800FDF2b27d1fCDd9";

async function main() {
  const [deployer] = await ethers.getSigners();
  const signer = process.env.VERIFIER_SIGNER_ADDRESS || deployer.address;
  console.log("Deployer:", deployer.address);

  const escrow = await ethers.deployContract("USDCEscrow", [USDC]);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("USDCEscrow:", escrowAddr);

  const taskReg = await ethers.deployContract("TaskRegistry", [escrowAddr, AGENT_REG]);
  await taskReg.waitForDeployment();
  const taskRegAddr = await taskReg.getAddress();
  console.log("TaskRegistry:", taskRegAddr);

  const verifier = await ethers.deployContract("VerifierBridge", [escrowAddr, AGENT_REG, taskRegAddr, signer]);
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("VerifierBridge:", verifierAddr);

  console.log("Wiring…");
  await (await escrow.setTaskRegistry(taskRegAddr)).wait();
  await (await escrow.setVerifierBridge(verifierAddr)).wait();
  await (await taskReg.setBidEngine(BID_ENGINE)).wait();
  await (await taskReg.setVerifierBridge(verifierAddr)).wait();

  // Re-point the reused V3 contracts at the new TaskRegistry / VerifierBridge.
  const agentReg = await ethers.getContractAt("AgentRegistry", AGENT_REG);
  await (await agentReg.setTaskRegistry(taskRegAddr)).wait();
  await (await agentReg.setVerifierBridge(verifierAddr)).wait();
  const bidEngine = await ethers.getContractAt("BidEngine", BID_ENGINE);
  await (await bidEngine.setTaskRegistry(taskRegAddr)).wait();

  console.log("\n=== V4 ADDRESSES ===");
  console.log(`VITE_CONTRACT_USDC_ESCROW=${escrowAddr}`);
  console.log(`VITE_CONTRACT_TASK_REGISTRY=${taskRegAddr}`);
  console.log(`VITE_CONTRACT_VERIFIER_BRIDGE=${verifierAddr}`);
  console.log(`VITE_CONTRACT_AGENT_REGISTRY=${AGENT_REG} (reused)`);
  console.log(`VITE_CONTRACT_BID_ENGINE=${BID_ENGINE} (reused)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
