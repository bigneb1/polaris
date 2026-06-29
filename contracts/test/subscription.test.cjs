const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);

/**
 * SubscriptionManager: pre-fund a recurring plan, release per-delivery on a
 * verifier-signed verdict, complete the plan, and cancel-with-refund.
 */
describe("SubscriptionManager", function () {
  let usdc, sub, owner, subscriber, agent, signer;
  const subId = ethers.id("sub-1");
  const PER = USDC(10);
  const TOTAL = 5;

  beforeEach(async () => {
    [owner, subscriber, agent, signer] = await ethers.getSigners();
    usdc = await ethers.deployContract("MockUSDC");
    sub = await ethers.deployContract("SubscriptionManager", [await usdc.getAddress(), signer.address]);
    await usdc.mint(subscriber.address, USDC(1000));
  });

  async function create(total = TOTAL) {
    await usdc.connect(subscriber).approve(await sub.getAddress(), PER * BigInt(total));
    return sub
      .connect(subscriber)
      .createSubscription(subId, agent.address, PER, total, {
        title: "Weekly thread",
        brief: "Write a thread",
        rubric: "Be accurate",
        taskType: "writing",
        schedule: "mon,wed,fri@09:00",
      });
  }

  function signDelivery(index, hash, score) {
    const inner = ethers.solidityPackedKeccak256(
      ["bytes32", "uint32", "bytes32", "uint8"],
      [subId, index, hash, score],
    );
    return signer.signMessage(ethers.getBytes(inner));
  }

  it("escrows the full plan budget on create", async () => {
    await create();
    expect(await usdc.balanceOf(await sub.getAddress())).to.equal(PER * BigInt(TOTAL));
    const s = await sub.getSubscription(subId);
    expect(s.totalDeliveries).to.equal(TOTAL);
    expect(s.escrowed).to.equal(PER * BigInt(TOTAL));
    expect(s.active).to.equal(true);
  });

  it("releases one slice per signed delivery and pays the agent", async () => {
    await create();
    const hash = ethers.id("delivery-0");
    const before = await usdc.balanceOf(agent.address);
    await sub.recordDelivery(subId, 0, hash, 88, await signDelivery(0, hash, 88));
    expect(await usdc.balanceOf(agent.address)).to.equal(before + PER);
    const s = await sub.getSubscription(subId);
    expect(s.deliveriesDone).to.equal(1);
    expect(s.escrowed).to.equal(PER * BigInt(TOTAL - 1));
  });

  it("rejects a forged verdict and a replayed delivery index", async () => {
    await create();
    const hash = ethers.id("d");
    // forged: signed by the wrong key
    const badSig = await agent.signMessage(ethers.getBytes(
      ethers.solidityPackedKeccak256(["bytes32", "uint32", "bytes32", "uint8"], [subId, 0, hash, 88]),
    ));
    await expect(sub.recordDelivery(subId, 0, hash, 88, badSig)).to.be.revertedWith("Bad signature");
    // valid once, then replay-blocked
    await sub.recordDelivery(subId, 0, hash, 88, await signDelivery(0, hash, 88));
    await expect(sub.recordDelivery(subId, 0, hash, 88, await signDelivery(0, hash, 88))).to.be.revertedWith("Released");
  });

  it("rejects a below-threshold score", async () => {
    await create();
    const hash = ethers.id("d");
    await expect(sub.recordDelivery(subId, 0, hash, 69, await signDelivery(0, hash, 69))).to.be.revertedWith("Below MIN_SCORE");
  });

  it("completes the plan after the last delivery", async () => {
    await create(2);
    const h0 = ethers.id("d0"), h1 = ethers.id("d1");
    await sub.recordDelivery(subId, 0, h0, 80, await signDelivery(0, h0, 80));
    await sub.recordDelivery(subId, 1, h1, 90, await signDelivery(1, h1, 90));
    const s = await sub.getSubscription(subId);
    expect(s.active).to.equal(false);
    expect(s.deliveriesDone).to.equal(2);
    expect(s.escrowed).to.equal(0n);
  });

  it("refunds the remaining escrow on cancel", async () => {
    await create();
    const h0 = ethers.id("d0");
    await sub.recordDelivery(subId, 0, h0, 80, await signDelivery(0, h0, 80)); // 1 of 5 used
    const before = await usdc.balanceOf(subscriber.address);
    await sub.connect(subscriber).cancelSubscription(subId);
    expect(await usdc.balanceOf(subscriber.address)).to.equal(before + PER * BigInt(TOTAL - 1));
    expect((await sub.getSubscription(subId)).active).to.equal(false);
  });

  it("only the subscriber can cancel", async () => {
    await create();
    await expect(sub.connect(agent).cancelSubscription(subId)).to.be.revertedWith("Not subscriber");
  });
});
