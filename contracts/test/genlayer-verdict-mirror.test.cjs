const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GenLayerVerdictMirror", function () {
  let mirror, signer, outsider;
  const decision = ethers.id("genlayer-decision");
  const sourceId = ethers.id("task-1");
  const evidence = ethers.id("evidence");
  const reasoning = ethers.id("reasoning");

  beforeEach(async () => {
    [, signer, outsider] = await ethers.getSigners();
    mirror = await ethers.deployContract("GenLayerVerdictMirror", [signer.address]);
  });

  async function signature(outcome = true) {
    const { chainId } = await ethers.provider.getNetwork();
    const digest = ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "uint256", "address", "bytes32", "bytes32", "uint8", "bool", "uint8", "bytes32"],
      [chainId, await mirror.getAddress(), decision, 5042002, outsider.address, sourceId, evidence, 1, outcome, 91, reasoning],
    );
    return signer.signMessage(ethers.getBytes(digest));
  }

  it("records a fully bound finalized verdict", async () => {
    const sig = await signature();
    await mirror.connect(signer).recordVerdict(decision, 5042002, outsider.address, sourceId, evidence, 1, true, 91, reasoning, sig);
    const v = await mirror.verdicts(decision);
    expect(v.outcome).to.equal(true);
    expect(v.score).to.equal(91);
    expect(v.evidenceHash).to.equal(evidence);
  });

  it("rejects outsiders, altered fields, and replay", async () => {
    const sig = await signature();
    await expect(mirror.connect(outsider).recordVerdict(decision, 5042002, outsider.address, sourceId, evidence, 1, true, 91, reasoning, sig)).to.be.revertedWith("Only relay");
    await expect(mirror.connect(signer).recordVerdict(decision, 5042002, outsider.address, sourceId, evidence, 1, false, 91, reasoning, sig)).to.be.revertedWith("Bad signature");
    await mirror.connect(signer).recordVerdict(decision, 5042002, outsider.address, sourceId, evidence, 1, true, 91, reasoning, sig);
    await expect(mirror.connect(signer).recordVerdict(decision, 5042002, outsider.address, sourceId, evidence, 1, true, 91, reasoning, sig)).to.be.revertedWith("Already recorded");
  });
});
