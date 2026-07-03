const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);

describe("RecurringMarket", function () {
  let usdc, agentReg, rm, owner, requester, agent, signer;
  const planId = ethers.id("plan-1");
  const META = { title: "Daily report", brief: "Summarize", rubric: "Be accurate", taskType: "research", schedule: "mon,wed,fri@09:00" };

  beforeEach(async () => {
    [owner, requester, agent, signer] = await ethers.getSigners();
    usdc = await ethers.deployContract("MockUSDC");
    agentReg = await ethers.deployContract("AgentRegistry", [await usdc.getAddress()]);
    rm = await ethers.deployContract("RecurringMarket", [await usdc.getAddress(), await agentReg.getAddress(), signer.address]);
    await usdc.mint(requester.address, USDC(1000));
    await usdc.mint(agent.address, USDC(200));
    // register the agent (stake 100 → rep 100, online)
    await usdc.connect(agent).approve(await agentReg.getAddress(), USDC(100));
    await agentReg.connect(agent).register(ethers.id("a1"), USDC(100), "Atlas", "research");
  });

  async function createAndBid(price = 8) {
    await usdc.connect(requester).approve(await rm.getAddress(), USDC(30));
    await rm.connect(requester).createPlan(planId, USDC(10), 3, 70, META);
    await rm.connect(agent).bid(planId, USDC(price), 1800);
  }
  function signDelivery(index, hash, score) {
    return signer.signMessage(ethers.getBytes(ethers.solidityPackedKeccak256(["bytes32", "uint32", "bytes32", "uint8"], [planId, index, hash, score])));
  }

  it("escrows the whole plan and accepts bids", async () => {
    await createAndBid();
    expect(await usdc.balanceOf(await rm.getAddress())).to.equal(USDC(30));
    expect(await rm.bidCount(planId)).to.equal(1);
  });

  it("award assigns the best bid and refunds the competitive savings", async () => {
    await createAndBid(8);
    const before = await usdc.balanceOf(requester.address);
    await rm.award(planId);
    // funded 10×3=30, winning 8×3=24 → refund 6
    expect(await usdc.balanceOf(requester.address)).to.equal(before + USDC(6));
    const p = await rm.getPlan(planId);
    expect(p.agent).to.equal(agent.address);
    expect(p.price).to.equal(USDC(8));
    expect(p.status).to.equal(2); // ACTIVE
  });

  it("releases one slice per verified delivery and completes", async () => {
    await createAndBid(8);
    await rm.award(planId);
    for (let i = 0; i < 3; i++) {
      const h = ethers.id(`d${i}`);
      const b = await usdc.balanceOf(agent.address);
      await rm.recordDelivery(planId, i, h, 90, await signDelivery(i, h, 90));
      expect(await usdc.balanceOf(agent.address)).to.equal(b + USDC(8));
    }
    expect((await rm.getPlan(planId)).status).to.equal(3); // COMPLETE
  });

  it("rejects offline/low-rep bids and forged delivery verdicts", async () => {
    await usdc.connect(requester).approve(await rm.getAddress(), USDC(30));
    await rm.connect(requester).createPlan(planId, USDC(10), 3, 70, META);
    // requester is not a registered agent → offline
    await expect(rm.connect(requester).bid(planId, USDC(8), 1800)).to.be.revertedWith("Agent offline");
    await rm.connect(agent).bid(planId, USDC(8), 1800);
    await rm.award(planId);
    const h = ethers.id("d");
    const bad = await agent.signMessage(ethers.getBytes(ethers.solidityPackedKeccak256(["bytes32", "uint32", "bytes32", "uint8"], [planId, 0, h, 90])));
    await expect(rm.recordDelivery(planId, 0, h, 90, bad)).to.be.revertedWith("Bad signature");
  });

  it("requester can cancel and reclaim remaining escrow", async () => {
    await createAndBid(8);
    await rm.award(planId);
    const h = ethers.id("d0");
    await rm.recordDelivery(planId, 0, h, 90, await signDelivery(0, h, 90)); // 1 of 3 paid (8)
    const before = await usdc.balanceOf(requester.address);
    await rm.connect(requester).cancelPlan(planId); // remaining escrow = 16
    expect(await usdc.balanceOf(requester.address)).to.equal(before + USDC(16));
  });
});
