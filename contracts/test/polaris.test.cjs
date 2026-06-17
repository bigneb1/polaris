const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const STAKE = USDC(100); // V2 min stake
const HASH = ethers.id("deliverable-bytes"); // mock deliverable hash for attestation

/**
 * Full Polaris V2 lifecycle on a local chain:
 *   post task → register agent → bid → award → sign verdict (+ deliverable hash) → settle.
 * Asserts the funds-flow fix, slash path, on-chain attestation, reputation,
 * the 100-USDC stake, and deactivate→withdraw-when-idle.
 */
describe("Polaris V2", function () {
  let usdc, escrow, agentReg, bidEngine, taskReg, verifier;
  let owner, requester, agent, signer;
  const taskId = ethers.id("task-1");

  beforeEach(async () => {
    [owner, requester, agent, signer] = await ethers.getSigners();

    usdc = await ethers.deployContract("MockUSDC");
    escrow = await ethers.deployContract("USDCEscrow", [await usdc.getAddress()]);
    agentReg = await ethers.deployContract("AgentRegistry", [await usdc.getAddress()]);
    bidEngine = await ethers.deployContract("BidEngine", [await agentReg.getAddress()]);
    taskReg = await ethers.deployContract("TaskRegistry", [await escrow.getAddress(), await agentReg.getAddress()]);
    verifier = await ethers.deployContract("VerifierBridge", [
      await escrow.getAddress(),
      await agentReg.getAddress(),
      await taskReg.getAddress(),
      signer.address,
    ]);

    await escrow.setTaskRegistry(await taskReg.getAddress());
    await escrow.setVerifierBridge(await verifier.getAddress());
    await agentReg.setVerifierBridge(await verifier.getAddress());
    await agentReg.setTaskRegistry(await taskReg.getAddress());
    await taskReg.setBidEngine(await bidEngine.getAddress());
    await taskReg.setVerifierBridge(await verifier.getAddress());
    await bidEngine.setTaskRegistry(await taskReg.getAddress());

    await usdc.mint(requester.address, USDC(100));
    await usdc.mint(agent.address, USDC(150)); // enough for the 100 stake + margin
  });

  async function register() {
    await usdc.connect(agent).approve(await agentReg.getAddress(), STAKE);
    await agentReg.connect(agent).register(ethers.id("agent-1"), STAKE, "Atlas", "research,writing");
  }
  async function postAndWin(budget = USDC(20), bid = USDC(18)) {
    await usdc.connect(requester).approve(await escrow.getAddress(), budget);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(taskId, budget, deadline, 0, "T", "D", "R", "research");
    await bidEngine.connect(agent).placeBid(taskId, bid, 1800);
    await bidEngine.awardBid(taskId);
  }
  async function sign(passed, score, hash = HASH) {
    const inner = ethers.solidityPackedKeccak256(["bytes32", "bool", "uint8", "bytes32"], [taskId, passed, score, hash]);
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

  it("enforces the 100 USDC minimum stake", async () => {
    await usdc.connect(agent).approve(await agentReg.getAddress(), USDC(50));
    await expect(
      agentReg.connect(agent).register(ethers.id("a"), USDC(50), "Cheap", "research"),
    ).to.be.revertedWith("Below min stake (100 USDC)");
  });

  it("pass path: settles, pays agent, records attestation + reputation", async () => {
    await register();
    await postAndWin();
    const before = await usdc.balanceOf(agent.address);
    await verifier.submitVerification(taskId, agent.address, requester.address, true, 92, HASH, await sign(true, 92));

    expect(await usdc.balanceOf(agent.address)).to.equal(before + USDC(20));
    const t = await taskReg.tasks(taskId);
    expect(t.status).to.equal(4); // SETTLED
    const a = await agentReg.agents(agent.address);
    expect(a.reputation).to.be.greaterThan(100n); // started at 100, +10 for >85
    expect(a.tasksCompleted).to.equal(1n);
    expect(a.activeTasks).to.equal(0n);
    // on-chain attestation of the deliverable
    const att = await verifier.getAttestation(taskId);
    expect(att.deliverableHash).to.equal(HASH);
    expect(att.score).to.equal(92);
    expect(att.passed).to.equal(true);
  });

  it("fail path: refunds requester and slashes 10% of the 100 stake", async () => {
    await register();
    await postAndWin();
    const reqBefore = await usdc.balanceOf(requester.address);
    await verifier.submitVerification(taskId, agent.address, requester.address, false, 30, HASH, await sign(false, 30));
    // requester gets the 20 budget back + 10 slash penalty (10% of 100 stake)
    expect(await usdc.balanceOf(requester.address)).to.equal(reqBefore + USDC(20) + USDC(10));
    expect((await agentReg.agents(agent.address)).stakedUsdc).to.equal(USDC(90));
  });

  it("rejects a verdict not signed by the trusted signer", async () => {
    await register();
    await postAndWin();
    const inner = ethers.solidityPackedKeccak256(["bytes32", "bool", "uint8", "bytes32"], [taskId, true, 92, HASH]);
    const forged = await agent.signMessage(ethers.getBytes(inner));
    await expect(
      verifier.submitVerification(taskId, agent.address, requester.address, true, 92, HASH, forged),
    ).to.be.revertedWith("Bad signature");
  });

  it("blocks deactivate while a task is active, then allows withdraw when idle", async () => {
    await register();
    await postAndWin();
    // active task → cannot deactivate
    await expect(agentReg.connect(agent).deactivate()).to.be.revertedWith("Has active tasks");
    // settle it
    await verifier.submitVerification(taskId, agent.address, requester.address, true, 92, HASH, await sign(true, 92));
    // now idle → deactivate + withdraw the full remaining stake
    await agentReg.connect(agent).deactivate();
    const before = await usdc.balanceOf(agent.address);
    await agentReg.connect(agent).withdrawStake();
    expect(await usdc.balanceOf(agent.address)).to.equal(before + STAKE);
    expect((await agentReg.agents(agent.address)).registered).to.equal(false);
  });

  it("direct-hire assigns a named agent and settles", async () => {
    await register();
    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(15));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitDirectTask(taskId, agent.address, USDC(15), deadline, "T", "D", "R", "research");
    const t = await taskReg.tasks(taskId);
    expect(t.assignedAgent).to.equal(agent.address);
    expect(t.status).to.equal(1); // ASSIGNED
    const before = await usdc.balanceOf(agent.address);
    await verifier.submitVerification(taskId, agent.address, requester.address, true, 88, HASH, await sign(true, 88));
    expect(await usdc.balanceOf(agent.address)).to.equal(before + USDC(15));
  });
});
