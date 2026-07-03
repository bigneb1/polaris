/**
 * Polaris deployment — strict order, each step wires the previous addresses.
 *   1. USDCEscrow        (or MockUSDC first on local)
 *   2. AgentRegistry
 *   3. BidEngine
 *   4. TaskRegistry
 *   5. VerifierBridge
 *   6. RevenueRouter
 * Then cross-wires permissions and prints a .env block.
 */
const { ethers, network } = require("hardhat");

// Arc system USDC (native). On local we deploy MockUSDC instead.
const ARC_USDC = "0x3600000000000000000000000000000000000000";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address, "| network:", network.name);

  // ── USDC ──────────────────────────────────────────────────────────────────
  let usdcAddress = process.env.USDC_ADDRESS || ARC_USDC;
  if (network.name === "hardhat" || network.name === "localhost") {
    const Mock = await ethers.deployContract("MockUSDC");
    await Mock.waitForDeployment();
    usdcAddress = await Mock.getAddress();
    console.log("MockUSDC:", usdcAddress);
  }

  // verifier signer: a dedicated key the backend uses to sign verdicts
  const signer = process.env.VERIFIER_SIGNER_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;

  // ── Core contracts ─────────────────────────────────────────────────────────
  const escrow = await ethers.deployContract("USDCEscrow", [usdcAddress]);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("USDCEscrow:", escrowAddr);

  const agentReg = await ethers.deployContract("AgentRegistry", [usdcAddress]);
  await agentReg.waitForDeployment();
  const agentRegAddr = await agentReg.getAddress();
  console.log("AgentRegistry:", agentRegAddr);

  const bidEngine = await ethers.deployContract("BidEngine", [agentRegAddr]);
  await bidEngine.waitForDeployment();
  const bidEngineAddr = await bidEngine.getAddress();
  console.log("BidEngine:", bidEngineAddr);

  const taskReg = await ethers.deployContract("TaskRegistry", [escrowAddr, agentRegAddr]);
  await taskReg.waitForDeployment();
  const taskRegAddr = await taskReg.getAddress();
  console.log("TaskRegistry:", taskRegAddr);

  const verifier = await ethers.deployContract("VerifierBridge", [
    escrowAddr,
    agentRegAddr,
    taskRegAddr,
    signer,
  ]);
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("VerifierBridge:", verifierAddr);

  const revenue = await ethers.deployContract("RevenueRouter", [usdcAddress, treasury]);
  await revenue.waitForDeployment();
  const revenueAddr = await revenue.getAddress();
  console.log("RevenueRouter:", revenueAddr);

  // ── Wire permissions ─────────────────────────────────────────────────────────
  console.log("Wiring…");
  await (await escrow.setTaskRegistry(taskRegAddr)).wait();
  await (await escrow.setVerifierBridge(verifierAddr)).wait();
  await (await agentReg.setVerifierBridge(verifierAddr)).wait();
  await (await agentReg.setTaskRegistry(taskRegAddr)).wait();
  await (await taskReg.setBidEngine(bidEngineAddr)).wait();
  await (await taskReg.setVerifierBridge(verifierAddr)).wait();
  await (await bidEngine.setTaskRegistry(taskRegAddr)).wait();

  console.log("\n=== SAVE TO .env (frontend + backend) ===");
  console.log(`VITE_USDC_ADDRESS=${usdcAddress}`);
  console.log(`VITE_CONTRACT_USDC_ESCROW=${escrowAddr}`);
  console.log(`VITE_CONTRACT_AGENT_REGISTRY=${agentRegAddr}`);
  console.log(`VITE_CONTRACT_BID_ENGINE=${bidEngineAddr}`);
  console.log(`VITE_CONTRACT_TASK_REGISTRY=${taskRegAddr}`);
  console.log(`VITE_CONTRACT_VERIFIER_BRIDGE=${verifierAddr}`);
  console.log(`VITE_CONTRACT_REVENUE_ROUTER=${revenueAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
