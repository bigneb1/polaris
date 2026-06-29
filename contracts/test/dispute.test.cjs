const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);

describe("DisputeManager", function () {
  let usdc, dm, owner, requester, agent, signer;
  const disputeId = ethers.id("dispute-1");
  const taskId = ethers.id("task-1");
  const BOND = USDC(5);

  beforeEach(async () => {
    [owner, requester, agent, signer] = await ethers.getSigners();
    usdc = await ethers.deployContract("MockUSDC");
    dm = await ethers.deployContract("DisputeManager", [await usdc.getAddress(), signer.address]);
    await usdc.mint(requester.address, USDC(100));
  });

  async function open() {
    await usdc.connect(requester).approve(await dm.getAddress(), BOND);
    return dm.connect(requester).openDispute(disputeId, taskId, agent.address, BOND, "Off-brief and shallow");
  }
  function sign(upheld) {
    const inner = ethers.solidityPackedKeccak256(["bytes32", "bool"], [disputeId, upheld]);
    return signer.signMessage(ethers.getBytes(inner));
  }

  it("escrows the bond on open", async () => {
    await open();
    expect(await usdc.balanceOf(await dm.getAddress())).to.equal(BOND);
    expect((await dm.getDispute(disputeId)).status).to.equal(1); // OPEN
  });

  it("upheld → refunds the bond to the requester", async () => {
    await open();
    const before = await usdc.balanceOf(requester.address);
    await dm.resolveDispute(disputeId, true, "Deliverable missed the brief", await sign(true));
    expect(await usdc.balanceOf(requester.address)).to.equal(before + BOND);
    expect((await dm.getDispute(disputeId)).status).to.equal(2); // UPHELD
  });

  it("rejected → bond goes to the agent (anti-abuse)", async () => {
    await open();
    const before = await usdc.balanceOf(agent.address);
    await dm.resolveDispute(disputeId, false, "Work met the brief; dispute frivolous", await sign(false));
    expect(await usdc.balanceOf(agent.address)).to.equal(before + BOND);
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
