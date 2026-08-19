const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);

describe("DisputeManager", function () {
  let usdc, escrow, agentReg, bidEngine, taskReg, verifier, dm;
  let owner, requester, agent, signer, treasury;
  const disputeId = ethers.id("dispute-1");
  const taskId = ethers.id("task-1");
  const HASH = ethers.id("deliverable-bytes");
  const BOND = USDC(10);

  beforeEach(async () => {
    [owner, requester, agent, signer, treasury] = await ethers.getSigners();

    // A dispute must reference a real, SETTLED task (see docs/AUDIT_REPORT.md,
    // Security #6/8) — so the fixture stands up the full V4 stack, exactly like
    // polaris.test.cjs, and settles one task before any dispute test runs.
    usdc = await ethers.deployContract("MockUSDC");
    escrow = await ethers.deployContract("USDCEscrow", [await usdc.getAddress()]);
    agentReg = await ethers.deployContract("AgentRegistry", [await usdc.getAddress()]);
    bidEngine = await ethers.deployContract("BidEngine", [await agentReg.getAddress(), 1_000_000n]);
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

    await usdc.mint(requester.address, USDC(1000));
    await usdc.mint(agent.address, USDC(150));
    await usdc.connect(agent).approve(await agentReg.getAddress(), USDC(100));
    await agentReg.connect(agent).register(ethers.id("agent-1"), USDC(100), "Atlas", "research");

    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
    await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
    await bidEngine.awardBid(taskId);
    await verifier.connect(signer).submitVerification(
      taskId, agent.address, requester.address, true, 92, HASH, await signVerdict(),
    );

    dm = await ethers.deployContract("DisputeManager", [
      await usdc.getAddress(), signer.address, treasury.address, await taskReg.getAddress(),
    ]);
    await usdc.mint(requester.address, USDC(100));
  });

  async function signVerdict() {
    const { chainId } = await ethers.provider.getNetwork();
    const inner = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
      [chainId, await verifier.getAddress(), taskId, agent.address, requester.address, true, 92, HASH],
    );
    return signer.signMessage(ethers.getBytes(inner));
  }

  async function open() {
    await usdc.connect(requester).approve(await dm.getAddress(), BOND);
    return dm.connect(requester).openDispute(disputeId, taskId, agent.address, BOND, "Off-brief and shallow");
  }
  async function sign(upheld) {
    const { chainId } = await ethers.provider.getNetwork();
    const inner = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "bool"],
      [chainId, await dm.getAddress(), disputeId, upheld],
    );
    return signer.signMessage(ethers.getBytes(inner));
  }

  it("escrows the bond on open", async () => {
    await open();
    expect(await usdc.balanceOf(await dm.getAddress())).to.equal(BOND);
    expect((await dm.getDispute(disputeId)).status).to.equal(1); // OPEN
  });

  it("rejects a dispute on a task that isn't settled, or with a mismatched requester/agent", async () => {
    const otherTaskId = ethers.id("task-not-settled");
    await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(otherTaskId, USDC(20), deadline, 0, "T", "D", "R", "research");
    await usdc.connect(requester).approve(await dm.getAddress(), BOND);
    await expect(
      dm.connect(requester).openDispute(ethers.id("d2"), otherTaskId, agent.address, BOND, "not settled"),
    ).to.be.revertedWith("Task not settled");

    await usdc.connect(agent).approve(await dm.getAddress(), BOND); // agent isn't the requester
    await usdc.mint(agent.address, BOND);
    await expect(
      dm.connect(agent).openDispute(ethers.id("d3"), taskId, agent.address, BOND, "not the requester"),
    ).to.be.revertedWith("Not this task's requester");

    await usdc.connect(requester).approve(await dm.getAddress(), BOND);
    await expect(
      dm.connect(requester).openDispute(ethers.id("d4"), taskId, requester.address, BOND, "wrong agent"),
    ).to.be.revertedWith("Agent mismatch");
  });

  it("upheld → refunds the bond to the requester", async () => {
    await open();
    const before = await usdc.balanceOf(requester.address);
    await dm.resolveDispute(disputeId, true, "Deliverable missed the brief", await sign(true));
    expect(await usdc.balanceOf(requester.address)).to.equal(before + BOND);
    expect((await dm.getDispute(disputeId)).status).to.equal(2); // UPHELD
  });

  it("rejected → requester forfeits 50% (30% agent, 20% treasury, 50% back)", async () => {
    await open();
    const aBefore = await usdc.balanceOf(agent.address);
    const tBefore = await usdc.balanceOf(treasury.address);
    const rBefore = await usdc.balanceOf(requester.address);
    await dm.resolveDispute(disputeId, false, "Work met the brief; dispute frivolous", await sign(false));
    expect(await usdc.balanceOf(agent.address)).to.equal(aBefore + USDC(3)); // 30%
    expect(await usdc.balanceOf(treasury.address)).to.equal(tBefore + USDC(2)); // 20%
    expect(await usdc.balanceOf(requester.address)).to.equal(rBefore + USDC(5)); // 50%
    expect((await dm.getDispute(disputeId)).status).to.equal(3); // REJECTED
  });

  it("rejects a forged verdict and double-resolution", async () => {
    await open();
    const bad = await agent.signMessage(ethers.getBytes(ethers.solidityPackedKeccak256(["bytes32", "bool"], [disputeId, true])));
    await expect(dm.resolveDispute(disputeId, true, "x", bad)).to.be.revertedWith("Bad signature");
    await dm.resolveDispute(disputeId, true, "ok", await sign(true));
    await expect(dm.resolveDispute(disputeId, true, "again", await sign(true))).to.be.revertedWith("Not open");
  });

  it("blocks a duplicate dispute id", async () => {
    await open();
    await usdc.connect(requester).approve(await dm.getAddress(), BOND);
    await expect(
      dm.connect(requester).openDispute(disputeId, taskId, agent.address, BOND, "again"),
    ).to.be.revertedWith("Exists");
  });
});
