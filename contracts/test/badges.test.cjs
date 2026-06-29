const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentBadges", function () {
  let badges, owner, admin, agent, stranger;

  beforeEach(async () => {
    [owner, admin, agent, stranger] = await ethers.getSigners();
    badges = await ethers.deployContract("AgentBadges");
  });

  it("owner can grant a tier and it's queryable", async () => {
    await badges.setBadge(agent.address, 4, "official Polaris agent");
    expect(await badges.getTier(agent.address)).to.equal(4);
    expect(await badges.noteOf(agent.address)).to.equal("official Polaris agent");
  });

  it("rejects non-admins and out-of-range tiers", async () => {
    await expect(badges.connect(stranger).setBadge(agent.address, 1, "")).to.be.revertedWith("Not admin");
    await expect(badges.setBadge(agent.address, 5, "")).to.be.revertedWith("Bad tier");
  });

  it("an owner-added admin can grant; revoking blocks them", async () => {
    await badges.setAdmin(admin.address, true);
    await badges.connect(admin).setBadge(agent.address, 2, "identity verified");
    expect(await badges.getTier(agent.address)).to.equal(2);
    await badges.setAdmin(admin.address, false);
    await expect(badges.connect(admin).setBadge(agent.address, 3, "")).to.be.revertedWith("Not admin");
  });

  it("only the owner can manage admins", async () => {
    await expect(badges.connect(stranger).setAdmin(stranger.address, true)).to.be.revertedWith("Only owner");
  });
});
