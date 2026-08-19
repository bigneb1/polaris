const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const STAKE = USDC(100);
const HASH = ethers.id("deliverable-bytes");

/**
 * Regression tests for the post-audit fixes in docs/AUDIT_REPORT.md:
 *   - VerifierBridge: caller access control + agent/requester signature binding (Security #1)
 *   - BidEngine: per-agent-per-task bid dedup (Bug #2) and stale-bid-from-a-
 *     withdrawn-agent no longer bricks awardBid (Bug #4)
 *   - TaskRegistry: slashOnTimeout (previously untested)
 */
describe("Post-audit security fixes", function () {
  let usdc, escrow, agentReg, bidEngine, taskReg, verifier;
  let owner, requester, agent, agent2, signer;
  const taskId = ethers.id("task-1");

  beforeEach(async () => {
    [owner, requester, agent, agent2, signer] = await ethers.getSigners();

    usdc = await ethers.deployContract("MockUSDC");
    escrow = await ethers.deployContract("USDCEscrow", [await usdc.getAddress()]);
    agentReg = await ethers.deployContract("AgentRegistry", [await usdc.getAddress()]);
    bidEngine = await ethers.deployContract("BidEngine", [await agentReg.getAddress(), 1_000_000n]);
    taskReg = await ethers.deployContract("TaskRegistry", [await escrow.getAddress(), await agentReg.getAddress()]);
    verifier = await ethers.deployContract("VerifierBridge", [
      await escrow.getAddress(), await agentReg.getAddress(), await taskReg.getAddress(), signer.address,
    ]);
    await escrow.setTaskRegistry(await taskReg.getAddress());
    await escrow.setVerifierBridge(await verifier.getAddress());
    await agentReg.setVerifierBridge(await verifier.getAddress());
    await agentReg.setTaskRegistry(await taskReg.getAddress());
    await taskReg.setBidEngine(await bidEngine.getAddress());
    await taskReg.setVerifierBridge(await verifier.getAddress());
    await bidEngine.setTaskRegistry(await taskReg.getAddress());

    await usdc.mint(requester.address, USDC(1000));
    for (const a of [agent, agent2]) {
      await usdc.mint(a.address, USDC(150));
      await usdc.connect(a).approve(await agentReg.getAddress(), STAKE);
      await agentReg.connect(a).register(ethers.id("agent-" + a.address), STAKE, "Atlas", "research");
    }
  });

  async function postAndWin(bidder = agent, budget = USDC(20), bid = USDC(18)) {
    await usdc.connect(requester).approve(await escrow.getAddress(), budget);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await taskReg.connect(requester).submitTask(taskId, budget, deadline, 0, "T", "D", "R", "research");
    await bidEngine.connect(bidder).placeBid(taskId, bid, 1800);
    await bidEngine.awardBid(taskId);
  }
  async function signVerdict(agentAddr, requesterAddr, passed, score, hash = HASH) {
    const { chainId } = await ethers.provider.getNetwork();
    const inner = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
      [chainId, await verifier.getAddress(), taskId, agentAddr, requesterAddr, passed, score, hash],
    );
    return signer.signMessage(ethers.getBytes(inner));
  }

  describe("VerifierBridge — access control + signature binding (Security #1)", () => {
    it("rejects submitVerification from anyone other than the trusted signer, even with a validly-signed payload", async () => {
      await postAndWin();
      const sig = await signVerdict(agent.address, requester.address, true, 92);
      // A random third party (not the backend) tries to relay the otherwise-valid verdict.
      await expect(
        verifier.connect(agent).submitVerification(taskId, agent.address, requester.address, true, 92, HASH, sig),
      ).to.be.revertedWith("Only backend");
    });

    it("rejects a signature replayed with a different agent/requester pair (the original exploit)", async () => {
      await postAndWin();
      const sig = await signVerdict(agent.address, requester.address, true, 92);
      // Attacker (agent2, separately registered) tries to redirect the payout to
      // itself by resubmitting the SAME signature with a different `agent`.
      await expect(
        verifier.connect(signer).submitVerification(taskId, agent2.address, requester.address, true, 92, HASH, sig),
      ).to.be.revertedWith("Bad signature");
      // Same for redirecting the slash beneficiary via a different `requester`.
      const failSig = await signVerdict(agent.address, requester.address, false, 30);
      await expect(
        verifier.connect(signer).submitVerification(taskId, agent.address, agent2.address, false, 30, HASH, failSig),
      ).to.be.revertedWith("Bad signature");
      // The correctly-addressed verdict still works.
      await verifier.connect(signer).submitVerification(taskId, agent.address, requester.address, true, 92, HASH, sig);
      expect((await taskReg.tasks(taskId)).status).to.equal(4); // SETTLED
    });
  });

  describe("BidEngine — bid-spam guard + stale-bid handling (Bugs #2, #4)", () => {
    it("rejects a second bid from the same agent on the same task", async () => {
      await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
      await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
      await expect(bidEngine.connect(agent).placeBid(taskId, USDC(15), 1800)).to.be.revertedWith("Already bid");
    });

    it("allows a fresh bid from the same agent after the task is reopened", async () => {
      await postAndWin(agent);
      await taskReg.reopenTask(taskId);
      await expect(bidEngine.connect(agent).placeBid(taskId, USDC(17), 1800)).to.not.be.reverted;
    });

    it("skips a stale bid from an agent who deactivated+withdrew before award, instead of bricking the auction", async () => {
      await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
      await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
      // agent bids, then leaves the market entirely (bidding doesn't touch activeTasks).
      await agentReg.connect(agent).deactivate();
      await agentReg.connect(agent).withdrawStake();
      // A second, still-eligible agent also bids.
      await bidEngine.connect(agent2).placeBid(taskId, USDC(19), 1800);
      // Regardless of which bid scored higher, awardBid must pick the still-online
      // agent2, not revert on the deregistered agent's stale bid.
      await expect(bidEngine.awardBid(taskId)).to.not.be.reverted;
      expect((await taskReg.tasks(taskId)).assignedAgent).to.equal(agent2.address);
    });
  });

  describe("TaskRegistry.slashOnTimeout (previously untested)", () => {
    it("refunds the requester and slashes the agent's stake once the deadline has passed", async () => {
      await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 100; // short window
      await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
      await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
      await bidEngine.awardBid(taskId);

      const reqBefore = await usdc.balanceOf(requester.address);
      const stakeBefore = (await agentReg.agents(agent.address)).stakedUsdc;

      await expect(taskReg.slashOnTimeout(taskId)).to.be.revertedWith("Before deadline");

      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine");

      await taskReg.slashOnTimeout(taskId);
      // Requester gets the 20 USDC budget refund PLUS the 10% stake slash
      // penalty (the slash beneficiary), matching AgentRegistry.slash's payout.
      expect(await usdc.balanceOf(requester.address)).to.equal(reqBefore + USDC(20) + stakeBefore / 10n);
      expect((await agentReg.agents(agent.address)).stakedUsdc).to.equal(stakeBefore - stakeBefore / 10n);
      expect((await taskReg.tasks(taskId)).status).to.equal(5); // CANCELLED
    });

    it("cannot be called twice for the same task", async () => {
      await usdc.connect(requester).approve(await escrow.getAddress(), USDC(20));
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 100;
      await taskReg.connect(requester).submitTask(taskId, USDC(20), deadline, 0, "T", "D", "R", "research");
      await bidEngine.connect(agent).placeBid(taskId, USDC(18), 1800);
      await bidEngine.awardBid(taskId);
      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine");
      await taskReg.slashOnTimeout(taskId);
      await expect(taskReg.slashOnTimeout(taskId)).to.be.reverted;
    });
  });
});
