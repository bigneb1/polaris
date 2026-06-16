const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);

/**
 * Full Polaris lifecycle on a local chain:
 *   post task → register agent → bid → award → sign verdict → settle.
 * Also asserts the funds-flow fix (single transferFrom) and the slash path.
 */
describe("Polaris", function () {
  let usdc, escrow, agentReg, bidEngine, taskReg, verifier;
  let owner, requester, agent, signer;
  const taskId = ethers.id("task-1");

  beforeEach(async () => {
    [owner, requester, agent, signer] = await ethers.getSigners();

    usdc = await ethers.deployContract("MockUSDC");
    escrow = await ethers.deployContract("USDCEscrow", [await usdc.getAddress()]);
    agentReg = await ethers.deployContract("AgentRegistry", [await usdc.getAddress()]);
    bidEngine = await ethers.deployContract("BidEngine", [await agentReg.getAddress()]);
    taskReg = await ethers.deployContract("TaskRegistry", [await escrow.getAddress()]);
    verifier = await ethers.deployContract("VerifierBridge", [
      await escrow.getAddress(),
      await agentReg.getAddress(),
      await taskReg.getAddress(),
      signer.address,
    ]);

    await escrow.setTaskRegistry(await taskReg.getAddress());
    await escrow.setVerifierBridge(await verifier.getAddress());
    await agentReg.setVerifierBridge(await verifier.getAddress());
    await taskReg.setBidEngine(await bidEngine.getAddress());
    await taskReg.setVerifierBridge(await verifier.getAddress());
    await bidEngine.setTaskRegistry(await taskReg.getAddress());

    await usdc.mint(requester.address, USDC(100));
    await usdc.mint(agent.address, USDC(50));
  });

  async function sign(passed, score) {
    const inner = ethers.solidityPackedKeccak256(["bytes32", "bool", "uint8"], [taskId, passed, score]);
    return signer.signMessage(ethers.getBytes(inner));
  }

  it("posts a task locking USDC exactly once (double-transfer bug fixed)", async () => {
    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

    await expect(
      taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "Title", "Desc", "Rubric", "research"),
    ).to.emit(taskReg, "TaskSubmitted");

    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(USDC(20));
    expect(await usdc.balanceOf(requester.address)).to.equal(USDC(80));
  });

  it("runs the full pass path: bid → award → settle releases USDC to agent", async () => {
    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");

    await usdc.connect(agent).approve(await agentReg.getAddress(), USDC(5));
    await agentReg.connect(agent).register(ethers.id("agent-1"), USDC(5), "Atlas", "research,writing");

    await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
    await bidEngine.awardBid(taskId);

    const before = await usdc.balanceOf(agent.address);
    const sig = await sign(true, 92);
    await verifier.submitVerification(taskId, agent.address, requester.address, true, 92, sig);

    expect(await usdc.balanceOf(agent.address)).to.equal(before + USDC(20));
    const t = await taskReg.tasks(taskId);
    expect(t.status).to.equal(4); // SETTLED
    expect((await agentReg.agents(agent.address)).reputation).to.be.greaterThan(500n);
  });

  it("runs the fail path: refunds requester and slashes agent stake", async () => {
    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");

    await usdc.connect(agent).approve(await agentReg.getAddress(), USDC(5));
    await agentReg.connect(agent).register(ethers.id("agent-1"), USDC(5), "Atlas", "research");
    await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
    await bidEngine.awardBid(taskId);

    const reqBefore = await usdc.balanceOf(requester.address);
    const sig = await sign(false, 30);
    await verifier.submitVerification(taskId, agent.address, requester.address, false, 30, sig);

    // requester gets the 20 budget back + 0.5 slash penalty (10% of 5 stake)
    expect(await usdc.balanceOf(requester.address)).to.equal(reqBefore + USDC(20) + USDC(0.5));
    expect((await agentReg.agents(agent.address)).stakedUsdc).to.equal(USDC(4.5));
  });

  it("rejects a verdict not signed by the trusted signer", async () => {
    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
    await usdc.connect(agent).approve(await agentReg.getAddress(), USDC(5));
    await agentReg.connect(agent).register(ethers.id("agent-1"), USDC(5), "Atlas", "research");
    await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
    await bidEngine.awardBid(taskId);

    const inner = ethers.solidityPackedKeccak256(["bytes32", "bool", "uint8"], [taskId, true, 92]);
    const forged = await agent.signMessage(ethers.getBytes(inner)); // wrong signer
    await expect(
      verifier.submitVerification(taskId, agent.address, requester.address, true, 92, forged),
    ).to.be.revertedWith("Bad signature");
  });
});
