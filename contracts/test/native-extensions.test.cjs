const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * The three subsystems that only existed for ERC-20 chains, now in native form:
 * staked disputes, prepaid subscriptions and the auctioned recurring market.
 *
 * These cover what actually differs from the ERC-20 versions rather than
 * re-testing the shared rules: value must arrive with the call (no allowance),
 * payouts must reach contract-account recipients (an ERC-4337 agent wallet is a
 * contract, and `transfer`'s 2300-gas stipend would strand it), stray value must be
 * refused so the balance keeps matching the escrow, and price scoring must work at
 * 18 decimals.
 */
describe("Native extensions (BOT Chain)", () => {
  const BOND = ethers.parseEther("0.05");
  const PER_DELIVERY = ethers.parseEther("0.02");
  const PRICE_UNIT = ethers.parseEther("1");

  let deployer, agent, requester, verifier, treasury, other;

  beforeEach(async () => {
    [deployer, agent, requester, verifier, treasury, other] = await ethers.getSigners();
  });

  /* ── NativeDisputeManager ──────────────────────────────────────────────── */
  describe("NativeDisputeManager", () => {
    let dm, taskReg;
    const taskId = ethers.id("task-1");
    const disputeId = ethers.id("dispute-1");

    /** Minimal stand-in for the task registry's `tasks()` view: the dispute
     *  contract only reads requester / assignedAgent / status from it. */
    beforeEach(async () => {
      taskReg = await ethers.deployContract("MockTaskRegistryView");
      await taskReg.setTask(taskId, requester.address, agent.address, 4); // 4 = SETTLED
      dm = await ethers.deployContract("NativeDisputeManager", [
        verifier.address,
        treasury.address,
        await taskReg.getAddress(),
      ]);
    });

    const resolve = async (upheld) => {
      const digest = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "bool"],
        [(await ethers.provider.getNetwork()).chainId, await dm.getAddress(), disputeId, upheld],
      );
      return dm.resolveDispute(disputeId, upheld, "jury note", await verifier.signMessage(ethers.getBytes(digest)));
    };

    const open = () =>
      dm.connect(requester).openDispute(disputeId, taskId, agent.address, BOND, "missed the brief", { value: BOND });

    it("takes the bond as msg.value, with no approval step", async () => {
      await open();
      expect(await ethers.provider.getBalance(await dm.getAddress())).to.equal(BOND);
      expect((await dm.getDispute(disputeId)).bond).to.equal(BOND);
    });

    it("rejects a bond that does not match the value sent", async () => {
      await expect(
        dm.connect(requester).openDispute(disputeId, taskId, agent.address, BOND, "x", { value: BOND - 1n }),
      ).to.be.revertedWith("Value must equal bond");
    });

    it("refuses a dispute from anyone but the task's requester", async () => {
      await expect(
        dm.connect(other).openDispute(disputeId, taskId, agent.address, BOND, "x", { value: BOND }),
      ).to.be.revertedWith("Not this task's requester");
    });

    it("refunds the whole bond when the jury upholds", async () => {
      await open();
      const before = await ethers.provider.getBalance(requester.address);
      await resolve(true);
      expect(await ethers.provider.getBalance(requester.address)).to.equal(before + BOND);
      expect(await ethers.provider.getBalance(await dm.getAddress())).to.equal(0n);
    });

    it("splits the bond 30/20/50 when the jury rejects", async () => {
      await open();
      const agentBefore = await ethers.provider.getBalance(agent.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const requesterBefore = await ethers.provider.getBalance(requester.address);
      await resolve(false);
      const toAgent = (BOND * 3000n) / 10000n;
      const toTreasury = (BOND * 2000n) / 10000n;
      expect(await ethers.provider.getBalance(agent.address)).to.equal(agentBefore + toAgent);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + toTreasury);
      expect(await ethers.provider.getBalance(requester.address)).to.equal(
        requesterBefore + (BOND - toAgent - toTreasury),
      );
      expect(await ethers.provider.getBalance(await dm.getAddress())).to.equal(0n);
    });

    it("rejects a verdict signed for a different contract instance", async () => {
      await open();
      const otherDm = await ethers.deployContract("NativeDisputeManager", [
        verifier.address,
        treasury.address,
        await taskReg.getAddress(),
      ]);
      const digest = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "bool"],
        [(await ethers.provider.getNetwork()).chainId, await otherDm.getAddress(), disputeId, true],
      );
      await expect(
        dm.resolveDispute(disputeId, true, "note", await verifier.signMessage(ethers.getBytes(digest))),
      ).to.be.revertedWith("Bad signature");
    });

    it("refuses stray value sent straight to the contract", async () => {
      await expect(requester.sendTransaction({ to: await dm.getAddress(), value: BOND })).to.be.reverted;
    });
  });

  /* ── NativeSubscriptionManager ─────────────────────────────────────────── */
  describe("NativeSubscriptionManager", () => {
    let sm;
    const subId = ethers.id("sub-1");
    const TOTAL = 3n;
    const meta = ["Weekly report", "Write it", "Be accurate", "research", "mon@09:00"];

    beforeEach(async () => {
      sm = await ethers.deployContract("NativeSubscriptionManager", [verifier.address]);
    });

    const create = () =>
      sm.connect(requester).createSubscription(subId, agent.address, PER_DELIVERY, TOTAL, meta, {
        value: PER_DELIVERY * TOTAL,
      });

    const deliver = async (index, score = 90) => {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(`work-${index}`));
      const digest = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
        [(await ethers.provider.getNetwork()).chainId, await sm.getAddress(), subId, index, hash, score],
      );
      return sm.recordDelivery(subId, index, hash, score, await verifier.signMessage(ethers.getBytes(digest)));
    };

    it("escrows the whole plan as msg.value", async () => {
      await create();
      expect(await ethers.provider.getBalance(await sm.getAddress())).to.equal(PER_DELIVERY * TOTAL);
    });

    it("rejects a plan whose value does not cover it", async () => {
      await expect(
        sm.connect(requester).createSubscription(subId, agent.address, PER_DELIVERY, TOTAL, meta, {
          value: PER_DELIVERY,
        }),
      ).to.be.revertedWith("Value must equal plan total");
    });

    it("pays one slice per signed delivery and completes the plan", async () => {
      await create();
      const before = await ethers.provider.getBalance(agent.address);
      await deliver(0);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(before + PER_DELIVERY);
      await deliver(1);
      await deliver(2);
      const sub = await sm.getSubscription(subId);
      expect(sub.active).to.equal(false);
      expect(sub.deliveriesDone).to.equal(TOTAL);
      expect(await ethers.provider.getBalance(await sm.getAddress())).to.equal(0n);
    });

    it("rejects a replayed delivery index and a below-threshold score", async () => {
      await create();
      await deliver(0);
      await expect(deliver(0)).to.be.revertedWith("Released");
      await expect(deliver(1, 50)).to.be.revertedWith("Below MIN_SCORE");
    });

    it("refunds the undelivered remainder on cancel, to the subscriber only", async () => {
      await create();
      await deliver(0);
      await expect(sm.connect(other).cancelSubscription(subId)).to.be.revertedWith("Not subscriber");
      const before = await ethers.provider.getBalance(await sm.getAddress());
      await sm.connect(requester).cancelSubscription(subId);
      expect(before).to.equal(PER_DELIVERY * (TOTAL - 1n));
      expect(await ethers.provider.getBalance(await sm.getAddress())).to.equal(0n);
    });

    it("pays a contract-account agent, which transfer()'s gas stipend would strand", async () => {
      const smartAgent = await ethers.deployContract("GasHungryReceiver");
      await sm
        .connect(requester)
        .createSubscription(ethers.id("sub-2"), await smartAgent.getAddress(), PER_DELIVERY, 1n, meta, {
          value: PER_DELIVERY,
        });
      const hash = ethers.keccak256(ethers.toUtf8Bytes("w"));
      const digest = ethers.solidityPackedKeccak256(
        ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
        [(await ethers.provider.getNetwork()).chainId, await sm.getAddress(), ethers.id("sub-2"), 0, hash, 90],
      );
      await sm.recordDelivery(ethers.id("sub-2"), 0, hash, 90, await verifier.signMessage(ethers.getBytes(digest)));
      expect(await ethers.provider.getBalance(await smartAgent.getAddress())).to.equal(PER_DELIVERY);
    });
  });

  /* ── NativeRecurringMarket ─────────────────────────────────────────────── */
  describe("NativeRecurringMarket", () => {
    let rm, registry;
    const planId = ethers.id("plan-1");
    const TOTAL = 2n;
    const meta = ["Daily thread", "Write it", "Accurate", "writing", "daily@09:00"];

    beforeEach(async () => {
      registry = await ethers.deployContract("NativeAgentRegistry", [ethers.parseEther("0.02")]);
      rm = await ethers.deployContract("NativeRecurringMarket", [
        await registry.getAddress(),
        verifier.address,
        PRICE_UNIT,
      ]);
      await registry
        .connect(agent)
        .register(ethers.id("agent-1"), ethers.parseEther("0.02"), "A", "writing", {
          value: ethers.parseEther("0.02"),
        });
    });

    const create = () =>
      rm.connect(requester).createPlan(planId, PER_DELIVERY, TOTAL, 70, meta, { value: PER_DELIVERY * TOTAL });

    it("escrows the plan as msg.value and refunds the competitive saving at award", async () => {
      await create();
      const bidPrice = PER_DELIVERY / 2n;
      await rm.connect(agent).bid(planId, bidPrice, 600);
      const before = await ethers.provider.getBalance(requester.address);
      await rm.award(planId);
      const saving = PER_DELIVERY * TOTAL - bidPrice * TOTAL;
      expect(await ethers.provider.getBalance(requester.address)).to.equal(before + saving);
      const plan = await rm.getPlan(planId);
      expect(plan.agent).to.equal(agent.address);
      expect(plan.price).to.equal(bidPrice);
    });

    it("scores price at 18 decimals, which a hardcoded 1e6 reference could not", async () => {
      await create();
      // A cheap bid must score ABOVE the price cap's floor. With the old hardcoded
      // 1_000_000 reference, (1e6 * 100) / 1e16 == 0 and price was ignored entirely.
      await rm.connect(agent).bid(planId, ethers.parseEther("0.01"), 600);
      const bid = await rm.bidsOf(planId, 0);
      expect(bid.score).to.be.greaterThan(0n);
      // 0.01 of a whole unit → priceScore caps at 100, so the 40% weight lands full.
      expect(bid.score).to.be.greaterThanOrEqual(40n);
    });

    it("releases one drop per signed delivery and completes", async () => {
      await create();
      await rm.connect(agent).bid(planId, PER_DELIVERY, 600);
      await rm.award(planId);
      const deliver = async (index) => {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`d-${index}`));
        const digest = ethers.solidityPackedKeccak256(
          ["uint256", "address", "bytes32", "uint32", "bytes32", "uint8"],
          [(await ethers.provider.getNetwork()).chainId, await rm.getAddress(), planId, index, hash, 90],
        );
        return rm.recordDelivery(planId, index, hash, 90, await verifier.signMessage(ethers.getBytes(digest)));
      };
      const before = await ethers.provider.getBalance(agent.address);
      await deliver(0);
      await deliver(1);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(before + PER_DELIVERY * TOTAL);
      expect((await rm.getPlan(planId)).status).to.equal(3); // COMPLETE
      expect(await ethers.provider.getBalance(await rm.getAddress())).to.equal(0n);
    });

    it("lets the requester cancel and reclaim the remaining escrow", async () => {
      await create();
      await rm.connect(requester).cancelPlan(planId);
      expect((await rm.getPlan(planId)).status).to.equal(4); // CANCELLED
      expect(await ethers.provider.getBalance(await rm.getAddress())).to.equal(0n);
    });
  });
});
