const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * ERC-8004 deployment flow.
 *
 * Polaris deploys its own ERC-8004 registries because the canonical ones aren't
 * usable on BOT Chain (mainnet's vanity proxies still delegate to a placeholder
 * that reverts; testnet has none, and the activating upgrade is signed by a key
 * Polaris doesn't hold). These tests exercise the exact two-step the deploy script
 * performs — bootstrap proxy, then upgrade to the real registry — so the flow is
 * proven locally before any gas is spent on a real chain.
 */
describe("ERC-8004 registries (Polaris-deployed)", () => {
  let owner, agentOwner, client;
  let identity, reputation, validation;

  /** proxy → bootstrap (sets owner) → upgradeToAndCall(real impl, initialize). */
  async function deployRegistry(bootstrap, bootstrapAddr, implName, implAddr, identityAddr, initArgs) {
    const initBootstrap = bootstrap.interface.encodeFunctionData("initialize", [owner.address, identityAddr]);
    const proxy = await ethers.deployContract("contracts/erc8004/ERC1967Proxy.sol:ERC1967Proxy", [bootstrapAddr, initBootstrap]);
    await proxy.waitForDeployment();
    const addr = await proxy.getAddress();

    const asImpl = await ethers.getContractAt(implName, addr);
    const asUups = await ethers.getContractAt("PolarisUUPSBootstrap", addr);
    await (await asUups.upgradeToAndCall(implAddr, asImpl.interface.encodeFunctionData("initialize", initArgs))).wait();
    return asImpl;
  }

  beforeEach(async () => {
    [owner, agentOwner, client] = await ethers.getSigners();

    const bootstrap = await ethers.deployContract("PolarisUUPSBootstrap");
    await bootstrap.waitForDeployment();
    const bootstrapAddr = await bootstrap.getAddress();

    const implAddrs = {};
    for (const name of ["IdentityRegistryUpgradeable", "ReputationRegistryUpgradeable", "ValidationRegistryUpgradeable"]) {
      const c = await ethers.deployContract(name);
      await c.waitForDeployment();
      implAddrs[name] = await c.getAddress();
    }

    const ZERO = ethers.ZeroAddress;
    identity = await deployRegistry(bootstrap, bootstrapAddr, "IdentityRegistryUpgradeable", implAddrs.IdentityRegistryUpgradeable, ZERO, []);
    const identityAddr = await identity.getAddress();
    reputation = await deployRegistry(bootstrap, bootstrapAddr, "ReputationRegistryUpgradeable", implAddrs.ReputationRegistryUpgradeable, identityAddr, [identityAddr]);
    validation = await deployRegistry(bootstrap, bootstrapAddr, "ValidationRegistryUpgradeable", implAddrs.ValidationRegistryUpgradeable, identityAddr, [identityAddr]);
  });

  it("initializes the Identity registry as the ERC-721 agent-identity collection", async () => {
    expect(await identity.name()).to.equal("AgentIdentity");
    expect(await identity.symbol()).to.equal("AGENT");
  });

  it("binds Reputation and Validation to the Identity registry", async () => {
    const identityAddr = await identity.getAddress();
    expect(await reputation.getIdentityRegistry()).to.equal(identityAddr);
    expect(await validation.getIdentityRegistry()).to.equal(identityAddr);
  });

  it("issues a portable agent identity that the agent's own wallet owns", async () => {
    // This is the identity a Polaris agent gets alongside its AgentRegistry entry:
    // an on-chain id owned by the agent's wallet, so ERC-8004's agentWallet and
    // Polaris's registered wallet are the same address.
    await identity.connect(agentOwner)["register(string)"]("https://polaris.example/agents/1.json");
    // Agent ids start at ZERO — the registry uses `agentId = _lastId++`.
    const agentId = 0n;
    expect(await identity.ownerOf(agentId)).to.equal(agentOwner.address);
    expect(await identity.tokenURI(agentId)).to.equal("https://polaris.example/agents/1.json");
    // The registry records the registering wallet under the reserved
    // "agentWallet" key — this is the ERC-8004 ↔ Polaris wallet binding.
    expect(await identity.getMetadata(agentId, "agentWallet")).to.equal(agentOwner.address.toLowerCase());
    expect(await identity.isAuthorizedOrOwner(agentOwner.address, agentId)).to.equal(true);
    expect(await identity.isAuthorizedOrOwner(client.address, agentId)).to.equal(false);
  });

  it("records standardized feedback against an agent id", async () => {
    await identity.connect(agentOwner)["register()"]();
    // A client leaves feedback — this is the standard's reputation surface, kept
    // separate from Polaris's own economic reputation (stake/slash/score).
    await reputation
      .connect(client)
      .giveFeedback(0n, 95, 0, "quality", "", "", "", ethers.ZeroHash);
    const [count, value] = await reputation.getSummary(0n, [client.address], "", "");
    expect(count).to.equal(1n);
    expect(value).to.equal(95n);
  });

  it("refuses self-feedback from the agent's own wallet", async () => {
    await identity.connect(agentOwner)["register()"]();
    await expect(
      reputation.connect(agentOwner).giveFeedback(0n, 100, 0, "quality", "", "", "", ethers.ZeroHash),
    ).to.be.revertedWith("Self-feedback not allowed");
  });

  it("keeps upgrade rights with the Polaris owner, not the standard's owner", async () => {
    // The upstream MinimalUUPS placeholder hardcodes the ERC-8004 owner address,
    // which would leave a Polaris-deployed proxy upgradeable only by a key we don't
    // hold. PolarisUUPSBootstrap takes the owner as a parameter instead.
    expect(await identity.owner()).to.equal(owner.address);
    const fresh = await ethers.deployContract("IdentityRegistryUpgradeable");
    await fresh.waitForDeployment();
    const asUups = await ethers.getContractAt("PolarisUUPSBootstrap", await identity.getAddress());
    await expect(asUups.connect(client).upgradeToAndCall(await fresh.getAddress(), "0x")).to.be.reverted;
  });
});
