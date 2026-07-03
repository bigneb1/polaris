const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const STAKE = USDC(100);

/**
 * Proves the BidEngine fairness lottery: two equally-qualified agents bid the
 * SAME price + speed on many auctions. Without the random term the deterministic
 * tie always crowns the first bidder; with it, wins spread across both. Asserts
 * neither agent is shut out — i.e. reputation/order no longer rigs the market.
 */
describe("BidEngine fairness lottery", function () {
  it("spreads wins between two identical bidders (randomness term)", async () => {
    const [, a1, a2] = await ethers.getSigners();
    const usdc = await ethers.deployContract("MockUSDC");
    const agentReg = await ethers.deployContract("AgentRegistry", [await usdc.getAddress()]);
    const escrow = await ethers.deployContract("USDCEscrow", [await usdc.getAddress()]);
    const bidEngine = await ethers.deployContract("BidEngine", [await agentReg.getAddress()]);
    const taskReg = await ethers.deployContract("TaskRegistry", [await escrow.getAddress(), await agentReg.getAddress()]);

    await escrow.setTaskRegistry(await taskReg.getAddress());
    await agentReg.setTaskRegistry(await taskReg.getAddress());
    await taskReg.setBidEngine(await bidEngine.getAddress());
    await bidEngine.setTaskRegistry(await taskReg.getAddress());

    for (const a of [a1, a2]) {
      await usdc.mint(a.address, USDC(200));
      await usdc.connect(a).approve(await agentReg.getAddress(), STAKE);
      await agentReg.connect(a).register(ethers.id("id-" + a.address), STAKE, "Agent", "research");
    }

    const wins = { [a1.address]: 0, [a2.address]: 0 };
    const N = 24;
    for (let i = 0; i < N; i++) {
      const taskId = ethers.id("fair-task-" + i);
      await usdc.mint(a1.address, USDC(20)); // fund requester role (a1) for escrow
      await usdc.connect(a1).approve(await escrow.getAddress(), USDC(20));
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await taskReg.connect(a1).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
      // identical bids: same price, same eta — only the random term differs
      await bidEngine.connect(a1).placeBid(taskId, USDC(10), 1800);
      await bidEngine.connect(a2).placeBid(taskId, USDC(10), 1800);
      await bidEngine.awardBid(taskId);
      const t = await taskReg.tasks(taskId);
      wins[t.assignedAgent] = (wins[t.assignedAgent] || 0) + 1;
    }

    // With a 0..100 random term on each bid, the chance either agent wins all N
    // is ~2·(1/2)^24 ≈ 1e-7, so both should win at least one auction.
    expect(wins[a1.address]).to.be.greaterThan(0);
    expect(wins[a2.address]).to.be.greaterThan(0);
    expect(wins[a1.address] + wins[a2.address]).to.equal(N);
  });
});
