const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Native-coin market (BOT Chain).
 *
 * Same market as Arc's, denominated in the chain's native coin instead of a
 * stablecoin: NativeEscrow + NativeAgentRegistry + NativeTaskRegistry, reusing
 * BidEngine and VerifierBridge unchanged. These tests cover the parts that differ
 * from the ERC-20 path — value must arrive with the call, payouts go out as native
 * transfers, and the stake floor is a deploy parameter because BOT has 18 decimals
 * where USDC has 6.
 */
describe("Native-coin market", () => {
  // Deliberately NOT the deployed floor (BOT testnet uses 0.02): the point of these
  // tests is that the floor is a constructor parameter, so exercise an arbitrary one.
  const MIN_STAKE = ethers.parseEther("1"); // 1 BOT
  const BUDGET = ethers.parseEther("0.1");
  const BID = ethers.parseEther("0.08");

  let deployer, agent, requester, verifier, other;
  let escrow, registry, bidEngine, taskReg, bridge;

  async function post(taskId, budget = BUDGET, deadlineOffset = 3600) {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + deadlineOffset;
    return taskReg
      .connect(requester)
      .submitTask(taskId, budget, deadline, 70, "T", "D", "R", "research", { value: budget });
  }

  /** The digest server/server.js signs: chain + bridge + task + agent + requester. */
  async function verdict(taskId, passed, score, deliverable = "work") {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(deliverable));
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const digest = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
      [chainId, await bridge.getAddress(), taskId, agent.address, requester.address, passed, score, hash],
    );
    return { hash, score, sig: await verifier.signMessage(ethers.getBytes(digest)) };
  }

  beforeEach(async () => {
    [deployer, agent, requester, verifier, other] = await ethers.getSigners();

    escrow = await ethers.deployContract("NativeEscrow");
    registry = await ethers.deployContract("NativeAgentRegistry", [MIN_STAKE]);
    bidEngine = await ethers.deployContract("BidEngine", [await registry.getAddress(), ethers.parseEther("1")]);
    taskReg = await ethers.deployContract("NativeTaskRegistry", [await escrow.getAddress(), await registry.getAddress()]);
    bridge = await ethers.deployContract("VerifierBridge", [
      await escrow.getAddress(),
      await registry.getAddress(),
      await taskReg.getAddress(),
      verifier.address,
    ]);

    await escrow.setTaskRegistry(await taskReg.getAddress());
    await escrow.setVerifierBridge(await bridge.getAddress());
    await taskReg.setBidEngine(await bidEngine.getAddress());
    await taskReg.setVerifierBridge(await bridge.getAddress());
    await registry.setTaskRegistry(await taskReg.getAddress());
    await registry.setVerifierBridge(await bridge.getAddress());
    await bidEngine.setTaskRegistry(await taskReg.getAddress());

    await registry.connect(agent).register(ethers.id("a1"), MIN_STAKE, "A1", "research", { value: MIN_STAKE });
  });

  describe("staking", () => {
    it("takes the stake from the value sent and starts reputation at 100", async () => {
      const a = await registry.agents(agent.address);
      expect(a.registered).to.equal(true);
      expect(a.stakedUsdc).to.equal(MIN_STAKE);
      expect(a.reputation).to.equal(100n);
      expect(await ethers.provider.getBalance(await registry.getAddress())).to.equal(MIN_STAKE);
    });

    it("rejects a stake below the deploy-time floor", async () => {
      const small = ethers.parseEther("0.5");
      await expect(
        registry.connect(other).register(ethers.id("a2"), small, "A2", "research", { value: small }),
      ).to.be.revertedWith("Below min stake");
    });

    it("rejects a declared stake that doesn't match the value sent", async () => {
      // The ABI keeps `stakeAmount` for compatibility, so it must be checked
      // against msg.value or an agent could claim collateral it never sent.
      await expect(
        registry.connect(other).register(ethers.id("a3"), MIN_STAKE, "A3", "research", { value: ethers.parseEther("0.1") }),
      ).to.be.revertedWith("Value must equal stakeAmount");
    });

    it("returns the stake on withdraw once idle, and refuses stray transfers", async () => {
      await registry.connect(agent).deactivate();
      const before = await ethers.provider.getBalance(agent.address);
      const rc = await (await registry.connect(agent).withdrawStake()).wait();
      const after = await ethers.provider.getBalance(agent.address);
      expect(after - before + rc.gasUsed * rc.gasPrice).to.equal(MIN_STAKE);
      await expect(agent.sendTransaction({ to: await registry.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("posting a task", () => {
    it("escrows the budget sent with the call — no approve step", async () => {
      const taskId = ethers.hexlify(ethers.randomBytes(32));
      await post(taskId);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(BUDGET);
      const t = await taskReg.tasks(taskId);
      expect(t.status).to.equal(0n); // OPEN
      expect(t.budgetUsdc).to.equal(BUDGET);
    });

    it("rejects a budget that doesn't match the value sent", async () => {
      const taskId = ethers.hexlify(ethers.randomBytes(32));
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await expect(
        taskReg
          .connect(requester)
          .submitTask(taskId, BUDGET, deadline, 70, "T", "D", "R", "research", { value: ethers.parseEther("0.01") }),
      ).to.be.revertedWith("Value must equal budget");
    });

    it("refunds the requester on cancel", async () => {
      const taskId = ethers.hexlify(ethers.randomBytes(32));
      await post(taskId);
      const before = await ethers.provider.getBalance(requester.address);
      const rc = await (await taskReg.connect(requester).cancelTask(taskId)).wait();
      const after = await ethers.provider.getBalance(requester.address);
      expect(after - before + rc.gasUsed * rc.gasPrice).to.equal(BUDGET);
    });

    it("refuses value sent straight to the escrow", async () => {
      await expect(requester.sendTransaction({ to: await escrow.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("settlement", () => {
    let taskId;
    beforeEach(async () => {
      taskId = ethers.hexlify(ethers.randomBytes(32));
      await post(taskId);
      await bidEngine.connect(agent).placeBid(taskId, BID, 1800);
      await bidEngine.connect(agent).awardBid(taskId);
    });

    it("assigns the winning bidder through the unchanged BidEngine", async () => {
      const t = await taskReg.tasks(taskId);
      expect(t.status).to.equal(1n); // ASSIGNED
      expect(t.assignedAgent).to.equal(agent.address);
      expect(t.winningBid).to.equal(BID);
    });

    it("pays the agent its bid and refunds the requester the rest on a pass", async () => {
      const { hash, score, sig } = await verdict(taskId, true, 88);
      const agentBefore = await ethers.provider.getBalance(agent.address);
      const reqBefore = await ethers.provider.getBalance(requester.address);

      await bridge.connect(verifier).submitVerification(taskId, agent.address, requester.address, true, score, hash, sig);

      expect((await ethers.provider.getBalance(agent.address)) - agentBefore).to.equal(BID);
      expect((await ethers.provider.getBalance(requester.address)) - reqBefore).to.equal(BUDGET - BID);
      expect((await taskReg.tasks(taskId)).status).to.equal(4n); // SETTLED
      const a = await registry.agents(agent.address);
      expect(a.reputation).to.equal(110n);
      expect(a.activeTasks).to.equal(0n);
      // Escrow fully drained for this task.
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("refunds the requester and slashes 10% of the native stake on a fail", async () => {
      const { hash, score, sig } = await verdict(taskId, false, 40);
      const reqBefore = await ethers.provider.getBalance(requester.address);

      await bridge.connect(verifier).submitVerification(taskId, agent.address, requester.address, false, score, hash, sig);

      // Requester gets the whole budget back plus the 10% slash penalty.
      const penalty = MIN_STAKE / 10n;
      expect((await ethers.provider.getBalance(requester.address)) - reqBefore).to.equal(BUDGET + penalty);
      const a = await registry.agents(agent.address);
      expect(a.stakedUsdc).to.equal(MIN_STAKE - penalty);
      expect(a.reputation).to.equal(50n);
      expect(a.tasksFailed).to.equal(1n);
      expect((await taskReg.tasks(taskId)).status).to.equal(5n); // CANCELLED
    });

    it("still rejects a verdict replayed with a different agent/requester pair", async () => {
      // The Security #1 fix must hold on the native path too: the digest binds the
      // exact pair, so a legitimately-signed verdict can't redirect the payout.
      const { hash, score, sig } = await verdict(taskId, true, 88);
      await expect(
        bridge.connect(verifier).submitVerification(taskId, other.address, requester.address, true, score, hash, sig),
      ).to.be.revertedWith("Bad signature");
    });

    it("refunds and slashes on a missed deadline", async () => {
      const late = ethers.hexlify(ethers.randomBytes(32));
      await post(late, BUDGET, 120);
      await bidEngine.connect(agent).placeBid(late, BID, 1800);
      await bidEngine.connect(agent).awardBid(late);
      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      const reqBefore = await ethers.provider.getBalance(requester.address);
      await taskReg.connect(other).slashOnTimeout(late); // permissionless
      const penalty = (await registry.agents(agent.address)).stakedUsdc / 9n; // 10% of pre-slash
      expect((await ethers.provider.getBalance(requester.address)) - reqBefore).to.be.greaterThan(BUDGET);
      expect(penalty).to.be.greaterThan(0n);
      expect((await taskReg.tasks(late)).status).to.equal(5n);
    });
  });
});
