/**
 * Additive upgrade for a native-value network: deploy the three native extensions
 * and a correctly-scaled BidEngine, then rewire, WITHOUT redeploying the core
 * market.
 *
 * Why not just re-run deploy-network.cjs: that would deploy a fresh escrow,
 * registry and task registry, orphaning every existing agent's stake, reputation
 * and task history on the chain. Everything below is additive or a rewire, so the
 * live market keeps its state.
 *
 * What this deploys:
 *   1. BidEngine with PRICE_UNIT = one whole unit of the settlement asset. The
 *      previously deployed engine used the old hardcoded 1_000_000 (one USDC), so
 *      on an 18-decimal coin `(1e6 * 100) / bidAmount` truncated to 0 for every
 *      realistic bid and the 25% price weight was silently dead: the auction
 *      ranked on reputation, speed and the fairness lottery only.
 *   2. NativeSubscriptionManager, NativeRecurringMarket, NativeDisputeManager, so
 *      subscriptions, the recurring market and staked disputes work here.
 *
 * Rewiring is only what the new BidEngine needs to be usable:
 *   taskRegistry.setBidEngine(new)  — authorises it to assign agents
 *   newBidEngine.setTaskRegistry()  — lets TaskRegistry.reopenAuction call back
 *
 * Env:
 *   CONFIRM_DEPLOY=bot_testnet      required, must match --network
 *   BOT_DEPLOYER_PRIVATE_KEY=0x…    optional per-network deployer key
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/upgrade-botchain-extensions.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const TARGETS = {
  bot_testnet: { id: "botchain-testnet", chainId: 968, label: "BOT Chain Testnet" },
  bot_mainnet: { id: "botchain-mainnet", chainId: 677, label: "BOT Chain" },
};

async function main() {
  const target = TARGETS[network.name];
  if (!target) throw new Error(`This script is for a native-value network, not ${network.name}.`);
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    throw new Error(`Set CONFIRM_DEPLOY=${network.name} to confirm you mean this network.`);
  }

  // Prove which chain we are actually connected to before spending anything.
  const live = await ethers.provider.getNetwork();
  if (Number(live.chainId) !== target.chainId) {
    throw new Error(`Connected to chain ${live.chainId}, expected ${target.chainId} for ${network.name}.`);
  }

  const file = path.join(__dirname, "..", "..", "deployments", target.id, "contracts.json");
  if (!fs.existsSync(file)) throw new Error(`No deployment artifact at ${file} — run deploy-network.cjs first.`);
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = artifact.contracts;

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const decimals = Number(artifact.escrowToken?.decimals ?? 18);
  const priceUnit = 10n ** BigInt(decimals);

  console.log(`\n${target.label} (chain ${target.chainId})`);
  console.log(` deployer       : ${deployer.address}`);
  console.log(` balance        : ${ethers.formatEther(balance)} ${artifact.escrowToken?.symbol ?? "BOT"}`);
  console.log(` price unit     : 1e${decimals}`);
  console.log(` keeping core   : escrow ${c.usdcEscrow}\n                  agentRegistry ${c.agentRegistry}\n                  taskRegistry ${c.taskRegistry}`);
  if (balance === 0n) throw new Error("Deployer has no gas.");

  const signer = artifact.verifierSigner || deployer.address;
  const treasury = artifact.treasury || deployer.address;

  const put = async (label, name, args) => {
    const inst = await ethers.deployContract(name, args);
    await inst.waitForDeployment();
    const addr = await inst.getAddress();
    console.log(` ${label.padEnd(26)} ${addr}`);
    return { inst, addr };
  };

  console.log("\nDeploying:");
  const bidEngine = await put("BidEngine (scaled)", "BidEngine", [c.agentRegistry, priceUnit]);
  const subs = await put("NativeSubscriptionManager", "NativeSubscriptionManager", [signer]);
  const rm = await put("NativeRecurringMarket", "NativeRecurringMarket", [c.agentRegistry, signer, priceUnit]);
  const dm = await put("NativeDisputeManager", "NativeDisputeManager", [signer, treasury, c.taskRegistry]);

  // ERC-4337: the canonical EntryPoint is already deployed on this chain, but with
  // no factory nothing could create an account for an agent to act through.
  const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
  const epCode = await ethers.provider.getCode(ENTRY_POINT);
  if (epCode === "0x") throw new Error(`No EntryPoint at ${ENTRY_POINT} on this chain.`);
  console.log(` EntryPoint v0.7 present    ${ENTRY_POINT} (${(epCode.length - 2) / 2} bytes)`);
  const accountFactory = await put("PolarisAccountFactory", "PolarisAccountFactory", [ENTRY_POINT]);

  console.log("\nRewiring the auction:");
  const taskRegistry = await ethers.getContractAt("NativeTaskRegistry", c.taskRegistry);
  await (await bidEngine.inst.setTaskRegistry(c.taskRegistry)).wait();
  console.log(`  BidEngine.setTaskRegistry  -> ${c.taskRegistry}`);
  await (await taskRegistry.setBidEngine(bidEngine.addr)).wait();
  console.log(`  TaskRegistry.setBidEngine  -> ${bidEngine.addr}`);

  // Confirm the new engine actually scores price now, rather than trusting it.
  const engine = await ethers.getContractAt("BidEngine", bidEngine.addr);
  const unit = await engine.PRICE_UNIT();
  if (unit !== priceUnit) throw new Error(`PRICE_UNIT is ${unit}, expected ${priceUnit}`);
  console.log(`  PRICE_UNIT verified on chain: ${unit} (a one-unit bid scores 100)`);

  artifact.contracts = {
    ...c,
    accountFactory: accountFactory.addr,
    entryPoint: ENTRY_POINT,
    bidEngine: bidEngine.addr,
    subscriptionManager: subs.addr,
    recurringMarket: rm.addr,
    disputeManager: dm.addr,
  };
  artifact.upgradedAtIso = new Date().toISOString();
  // The new contracts start at this block; the core market keeps its original one.
  artifact.extensionsFromBlock = await ethers.provider.getBlockNumber();
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nArtifact updated: ${path.relative(process.cwd(), file)}`);
  console.log("Mirror these into src/lib/networks/botchain.ts, then verify on the explorer.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
