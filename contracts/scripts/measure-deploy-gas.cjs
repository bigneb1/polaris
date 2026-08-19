/**
 * What does deploying the whole Polaris set to a native-coin network actually cost?
 *
 * Runs the real deployment sequence against a local chain and sums `gasUsed` from
 * every receipt: the core market, the wiring transactions, the extensions, the three
 * ERC-8004 registries (bootstrap proxy + upgrade, as deploy-erc8004.cjs does it) and
 * the ERC-4337 account factory. Deployment gas is deterministic for given bytecode and
 * constructor args, so a local measurement is the same gas the live chain would charge.
 *
 * Priced at BOT Chain's flat 20 gwei, which is the same on testnet and mainnet, so the
 * BOT figure is exact rather than an estimate.
 *
 *   npx hardhat run scripts/measure-deploy-gas.cjs
 */
const { ethers } = require("hardhat");

const GAS_PRICE_GWEI = Number(process.env.GAS_PRICE_GWEI || 20);
const MIN_STAKE = ethers.parseEther(process.env.MIN_STAKE_NATIVE || "0.02");
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const rows = [];
let total = 0n;

async function record(group, label, promise) {
  const c = await promise;
  const receipt = await (c.deploymentTransaction ? c.deploymentTransaction().wait() : c.wait());
  const gas = receipt.gasUsed;
  total += gas;
  rows.push({ group, label, gas });
  return c;
}

async function tx(group, label, promise) {
  const receipt = await (await promise).wait();
  total += receipt.gasUsed;
  rows.push({ group, label, gas: receipt.gasUsed });
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const signer = deployer.address;
  const treasury = deployer.address;
  const priceUnit = 10n ** 18n; // BOT is 18 decimals

  /* Core market — the native-value set, as bot_mainnet is a native network. */
  const escrow = await record("core", "NativeEscrow", ethers.deployContract("NativeEscrow", []));
  const agentRegistry = await record("core", "NativeAgentRegistry", ethers.deployContract("NativeAgentRegistry", [MIN_STAKE]));
  const bidEngine = await record("core", "BidEngine", ethers.deployContract("BidEngine", [await agentRegistry.getAddress(), priceUnit]));
  const taskRegistry = await record("core", "NativeTaskRegistry", ethers.deployContract("NativeTaskRegistry", [await escrow.getAddress(), await agentRegistry.getAddress()]));
  const verifierBridge = await record("core", "VerifierBridge", ethers.deployContract("VerifierBridge", [
    await escrow.getAddress(), await agentRegistry.getAddress(), await taskRegistry.getAddress(), signer,
  ]));

  /* Wiring — not deployments, but you cannot use the system without them. */
  await tx("wiring", "escrow.setTaskRegistry", escrow.setTaskRegistry(await taskRegistry.getAddress()));
  await tx("wiring", "escrow.setVerifierBridge", escrow.setVerifierBridge(await verifierBridge.getAddress()));
  await tx("wiring", "taskRegistry.setBidEngine", taskRegistry.setBidEngine(await bidEngine.getAddress()));
  await tx("wiring", "taskRegistry.setVerifierBridge", taskRegistry.setVerifierBridge(await verifierBridge.getAddress()));
  await tx("wiring", "agentRegistry.setTaskRegistry", agentRegistry.setTaskRegistry(await taskRegistry.getAddress()));
  await tx("wiring", "agentRegistry.setVerifierBridge", agentRegistry.setVerifierBridge(await verifierBridge.getAddress()));
  await tx("wiring", "bidEngine.setTaskRegistry", bidEngine.setTaskRegistry(await taskRegistry.getAddress()));

  /* Extensions */
  await record("extensions", "AgentBadges", ethers.deployContract("AgentBadges", []));
  await record("extensions", "NativeSubscriptionManager", ethers.deployContract("NativeSubscriptionManager", [signer]));
  await record("extensions", "NativeRecurringMarket", ethers.deployContract("NativeRecurringMarket", [await agentRegistry.getAddress(), signer, priceUnit]));
  await record("extensions", "NativeDisputeManager", ethers.deployContract("NativeDisputeManager", [signer, treasury, await taskRegistry.getAddress()]));

  /* ERC-8004: bootstrap, then one proxy + one implementation + one upgrade each. */
  const bootstrap = await record("erc8004", "PolarisUUPSBootstrap", ethers.deployContract("PolarisUUPSBootstrap"));
  const bootstrapAddr = await bootstrap.getAddress();
  let identityAddr = ethers.ZeroAddress;
  for (const [name, label] of [
    ["IdentityRegistryUpgradeable", "Identity"],
    ["ReputationRegistryUpgradeable", "Reputation"],
    ["ValidationRegistryUpgradeable", "Validation"],
  ]) {
    const impl = await record("erc8004", `${label} implementation`, ethers.deployContract(name));
    const initBootstrap = bootstrap.interface.encodeFunctionData("initialize", [deployer.address, identityAddr]);
    const proxy = await record("erc8004", `${label} proxy`, ethers.deployContract("contracts/erc8004/ERC1967Proxy.sol:ERC1967Proxy", [bootstrapAddr, initBootstrap]));
    const proxyAddr = await proxy.getAddress();
    const asBootstrap = await ethers.getContractAt("PolarisUUPSBootstrap", proxyAddr);
    // Identity takes no init args; the other two take the identity registry's address.
    const initArgs = name === "IdentityRegistryUpgradeable" ? [] : [identityAddr];
    const initReal = impl.interface.encodeFunctionData("initialize", initArgs);
    await tx("erc8004", `${label} upgradeToAndCall`, asBootstrap.upgradeToAndCall(await impl.getAddress(), initReal));
    if (name === "IdentityRegistryUpgradeable") identityAddr = proxyAddr;
  }

  /* ERC-4337: the account factory. EntryPoint v0.7 is canonical and not deployed. */
  await record("erc4337", "PolarisAccountFactory", ethers.deployContract("PolarisAccountFactory", [ENTRY_POINT]));

  /* Report */
  const price = ethers.parseUnits(String(GAS_PRICE_GWEI), "gwei");
  const groups = {};
  console.log(`\n  ${"contract / tx".padEnd(34)} ${"gas".padStart(10)}  ${"BOT".padStart(12)}`);
  console.log("  " + "─".repeat(60));
  let lastGroup = null;
  for (const r of rows) {
    if (r.group !== lastGroup) {
      console.log(`  ${r.group}`);
      lastGroup = r.group;
    }
    groups[r.group] = (groups[r.group] ?? 0n) + r.gas;
    console.log(`    ${r.label.padEnd(32)} ${r.gas.toString().padStart(10)}  ${ethers.formatEther(r.gas * price).padStart(12)}`);
  }
  console.log("  " + "─".repeat(60));
  for (const [g, gas] of Object.entries(groups)) {
    console.log(`  ${g.padEnd(34)} ${gas.toString().padStart(10)}  ${ethers.formatEther(gas * price).padStart(12)}`);
  }
  console.log("  " + "─".repeat(60));
  console.log(`  ${"TOTAL".padEnd(34)} ${total.toString().padStart(10)}  ${ethers.formatEther(total * price).padStart(12)} BOT`);
  console.log(`\n  at ${GAS_PRICE_GWEI} gwei (BOT Chain's flat gas price, same on testnet and mainnet)`);
  const withBuffer = (total * price * 130n) / 100n;
  console.log(`  fund the deployer with at least ${ethers.formatEther(withBuffer)} BOT (30% headroom)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
