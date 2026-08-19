/**
 * Network-aware Polaris deployment.
 *
 *   npx hardhat run scripts/deploy-network.cjs --network bot_testnet
 *
 * Deploys the whole Polaris contract set to ONE network, wires it, and writes
 * `deployments/<network-id>/contracts.json`. The backend and the frontend both
 * read that artifact, so a fresh deployment needs no hand-edited env vars.
 *
 * SAFEGUARDS — deploying to the wrong chain is the expensive mistake here, so the
 * script refuses to run until it has proven where it is:
 *   1. the hardhat network must be one it knows,
 *   2. the LIVE chain id (eth_chainId) must match that network's expected id,
 *   3. an ERC-20 escrow token must exist on that chain and report 6 decimals
 *      (native-coin networks skip this — value moves as msg.value),
 *   4. the deployer must hold gas,
 *   5. CONFIRM_DEPLOY must equal the hardhat network name,
 *   6. Arc is refused outright unless FORCE_ARC=1 — Arc is live, and a redeploy
 *      would orphan every existing task, agent and stake.
 *
 * Env:
 *   CONFIRM_DEPLOY=bot_testnet     required, must match --network
 *   VERIFIER_SIGNER_ADDRESS=0x…    verdict signer (defaults to the deployer)
 *   TREASURY_ADDRESS=0x…           dispute/treasury payee (defaults to the deployer)
 *   ESCROW_TOKEN=0x…               override the ERC-20 escrow asset (Arc only)
 *   MIN_STAKE_NATIVE=0.02          agent collateral in whole coins on native networks
 *                                  (this is the default — BOT testnet is deployed with it)
 *   BOT_DEPLOYER_PRIVATE_KEY=0x…   optional per-network deployer key
 */
const { ethers, network, run } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const TARGETS = {
  arc_testnet: {
    id: "arc-testnet",
    chainId: 5042002,
    label: "Arc Testnet",
    escrowToken: "0x3600000000000000000000000000000000000000",
    explorer: "https://testnet.arcscan.app",
    gasSymbol: "USDC",
    allowTestToken: false,
    live: true, // already deployed and in production — protected
  },
  // BOT Chain settles in its OWN native coin, not a stablecoin — so it uses the
  // native-value contract set (NativeEscrow / NativeAgentRegistry /
  // NativeTaskRegistry) with BidEngine and VerifierBridge reused unchanged.
  // Per the current scope, only the core market ships here: the subscription,
  // recurring-market and dispute contracts are ERC-20-based and are not deployed
  // on native networks.
  bot_testnet: {
    id: "botchain-testnet",
    chainId: 968,
    label: "BOT Chain Testnet",
    native: true,
    explorer: "https://scan.bohr.life",
    gasSymbol: "BOT",
    live: false,
  },
  bot_mainnet: {
    id: "botchain-mainnet",
    chainId: 677,
    label: "BOT Chain",
    native: true,
    explorer: "https://scan.botchain.ai",
    gasSymbol: "BOT",
    live: false,
  },
};

/**
 * Default agent collateral on a native network, in whole coins. BOT is 18
 * decimals, so USDC's 100_000_000 constant would be dust here — the floor is a
 * deploy parameter instead.
 *
 * 0.02 BOT keeps the all-in cost of registering an agent at roughly 0.02 BOT
 * (registration gas measured at 0.0034 BOT / ~170k gas at the network's flat
 * 20 gwei). Note the trade-off this makes deliberately: at this size the stake is
 * a spam gate rather than meaningful collateral — a slash takes 10% of it — so the
 * economic deterrent is reputation loss, not the forfeited amount.
 */
const NATIVE_MIN_STAKE = process.env.MIN_STAKE_NATIVE || "0.02";

const MIN_GAS = ethers.parseEther(process.env.MIN_DEPLOY_GAS || "0.05");

function abort(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function preflight() {
  const target = TARGETS[network.name];
  if (!target) {
    abort(`Unknown network "${network.name}". Known: ${Object.keys(TARGETS).join(", ")}`);
  }

  const live = await ethers.provider.getNetwork();
  const liveChainId = Number(live.chainId);
  const [deployer] = await ethers.getSigners();
  if (!deployer) abort("No deployer account — set DEPLOYER_PRIVATE_KEY (or BOT_DEPLOYER_PRIVATE_KEY).");
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("\n─────────────────────────────────────────────");
  console.log(" POLARIS DEPLOYMENT PREFLIGHT");
  console.log("─────────────────────────────────────────────");
  console.log(` Network        : ${target.label} (${target.id})`);
  console.log(` Hardhat name   : ${network.name}`);
  console.log(` Chain ID       : expected ${target.chainId} · live ${liveChainId}`);
  console.log(` RPC            : ${network.config.url}`);
  console.log(` Explorer       : ${target.explorer}`);
  console.log(` Deployer       : ${deployer.address}`);
  console.log(` Balance        : ${ethers.formatEther(balance)} ${target.gasSymbol}`);

  if (liveChainId !== target.chainId) {
    abort(`Chain id mismatch — the RPC reports ${liveChainId}, expected ${target.chainId}. Wrong RPC URL?`);
  }
  if (target.live && process.env.FORCE_ARC !== "1") {
    abort(
      `${target.label} is a LIVE deployment. Redeploying would orphan every existing task, agent and stake.\n  If you truly mean it: FORCE_ARC=1`,
    );
  }
  if (balance < MIN_GAS) {
    abort(
      `Deployer holds ${ethers.formatEther(balance)} ${target.gasSymbol}; needs at least ${ethers.formatEther(MIN_GAS)}.\n  Fund ${deployer.address} and retry.`,
    );
  }
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    abort(`Set CONFIRM_DEPLOY=${network.name} to confirm you mean to deploy to ${target.label}.`);
  }

  return { target, deployer };
}

/** Resolve the escrow asset: the chain's native coin, or an ERC-20 stablecoin. */
async function resolveEscrowToken(target) {
  if (target.native) {
    // No token contract at all — value moves as msg.value.
    console.log(` Escrow asset   : native ${target.gasSymbol} (18 dec) — same coin as gas`);
    console.log(` Min stake      : ${NATIVE_MIN_STAKE} ${target.gasSymbol}`);
    return { address: null, symbol: target.gasSymbol, decimals: 18, native: true };
  }

  const address = process.env.ESCROW_TOKEN || target.escrowToken;
  const erc20 = new ethers.Contract(
    address,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    ethers.provider,
  );
  let symbol, decimals;
  try {
    [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  } catch {
    abort(`Escrow token ${address} doesn't look like an ERC-20 on ${target.label}.`);
  }
  decimals = Number(decimals);
  console.log(` Escrow asset   : ${symbol} (${decimals} dec) at ${address}`);
  if (decimals !== 6) {
    abort(
      `Escrow token reports ${decimals} decimals. AgentRegistry's MIN_STAKE constant (100_000_000) assumes 6.`,
    );
  }
  return { address, symbol, decimals, native: false };
}

async function main() {
  const { target, deployer } = await preflight();
  const token = await resolveEscrowToken(target);

  const signer = process.env.VERIFIER_SIGNER_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  console.log(` Verdict signer : ${signer}`);
  console.log(` Treasury       : ${treasury}`);
  console.log("─────────────────────────────────────────────\n");

  const startBlock = await ethers.provider.getBlockNumber();
  const deployed = {};
  const put = async (label, key, name, args) => {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    deployed[key] = await c.getAddress();
    console.log(` ${label.padEnd(20)} ${deployed[key]}`);
    return c;
  };

  console.log(`Core market (${token.native ? "native-value" : "ERC-20"} contracts):`);
  const minStakeWei = ethers.parseEther(NATIVE_MIN_STAKE);
  const escrow = token.native
    ? await put("NativeEscrow", "usdcEscrow", "NativeEscrow", [])
    : await put("USDCEscrow", "usdcEscrow", "USDCEscrow", [token.address]);
  const agentRegistry = token.native
    ? await put("NativeAgentRegistry", "agentRegistry", "NativeAgentRegistry", [minStakeWei])
    : await put("AgentRegistry", "agentRegistry", "AgentRegistry", [token.address]);
  // BidEngine and VerifierBridge move no funds themselves — they're reused as-is
  // on both the ERC-20 and native paths. BidEngine does need to know what "one
  // unit" of the settlement asset is: its price score used to divide a hardcoded
  // 1_000_000 (one USDC) by the bid, which on an 18-decimal coin rounds to 0 for
  // every realistic bid and silently removes price from the ranking entirely.
  const priceUnit = 10n ** BigInt(token.decimals);
  console.log(` price unit          1e${token.decimals} (one whole ${token.symbol})`);
  const bidEngine = await put("BidEngine", "bidEngine", "BidEngine", [deployed.agentRegistry, priceUnit]);
  const taskRegistry = token.native
    ? await put("NativeTaskRegistry", "taskRegistry", "NativeTaskRegistry", [deployed.usdcEscrow, deployed.agentRegistry])
    : await put("TaskRegistry", "taskRegistry", "TaskRegistry", [deployed.usdcEscrow, deployed.agentRegistry]);
  const verifierBridge = await put("VerifierBridge", "verifierBridge", "VerifierBridge", [
    deployed.usdcEscrow,
    deployed.agentRegistry,
    deployed.taskRegistry,
    signer,
  ]);
  // RevenueRouter collects an ERC-20 protocol fee; it has no native equivalent yet.
  if (!token.native) await put("RevenueRouter", "revenueRouter", "RevenueRouter", [token.address, treasury]);

  console.log("\nWiring…");
  await (await escrow.setTaskRegistry(deployed.taskRegistry)).wait();
  await (await escrow.setVerifierBridge(deployed.verifierBridge)).wait();
  await (await taskRegistry.setBidEngine(deployed.bidEngine)).wait();
  await (await taskRegistry.setVerifierBridge(deployed.verifierBridge)).wait();
  await (await agentRegistry.setTaskRegistry(deployed.taskRegistry)).wait();
  await (await agentRegistry.setVerifierBridge(deployed.verifierBridge)).wait();
  await (await bidEngine.setTaskRegistry(deployed.taskRegistry)).wait();
  console.log(" wired: escrow ↔ taskRegistry ↔ verifierBridge ↔ agentRegistry ↔ bidEngine");
  void verifierBridge;

  console.log("\nExtensions:");
  // AgentBadges holds no funds, so it ships on every network.
  await put("AgentBadges", "agentBadges", "AgentBadges", []);
  if (token.native) {
    // Native-value twins, so subscriptions, the recurring market and staked
    // disputes work here exactly as they do on an ERC-20 chain.
    await put("NativeSubscriptionManager", "subscriptionManager", "NativeSubscriptionManager", [signer]);
    await put("NativeRecurringMarket", "recurringMarket", "NativeRecurringMarket", [
      deployed.agentRegistry,
      signer,
      priceUnit,
    ]);
    await put("NativeDisputeManager", "disputeManager", "NativeDisputeManager", [
      signer,
      treasury,
      deployed.taskRegistry,
    ]);
  } else {
    await put("SubscriptionManager", "subscriptionManager", "SubscriptionManager", [token.address, signer]);
    await put("RecurringMarket", "recurringMarket", "RecurringMarket", [token.address, deployed.agentRegistry, signer]);
    await put("DisputeManager", "disputeManager", "DisputeManager", [token.address, signer, treasury, deployed.taskRegistry]);
  }

  /* ── Artifact ─────────────────────────────────────────────────────────────── */
  const dir = path.join(__dirname, "..", "..", "deployments", target.id);
  const file = path.join(dir, "contracts.json");

  // Carry over addresses this script doesn't own. deploy-erc8004.cjs merges its
  // registries into the same artifact, and those contracts don't depend on the
  // market — rewriting the file from scratch would silently drop them and leave
  // the runtime with no agent-identity registry.
  const KEPT = ["erc8004Identity", "erc8004Reputation", "erc8004Validation", "accountFactory"];
  const carried = {};
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const k of KEPT) if (prev.contracts?.[k]) carried[k] = prev.contracts[k];
      if (Object.keys(carried).length) {
        console.log(`\n Carried over from the previous artifact: ${Object.keys(carried).join(", ")}`);
      }
    } catch {
      /* unreadable previous artifact — nothing to carry */
    }
  }

  const artifact = {
    network: target.id,
    label: target.label,
    chainId: target.chainId,
    explorer: target.explorer,
    deployedAtIso: new Date().toISOString(),
    deployer: deployer.address,
    verifierSigner: signer,
    treasury,
    // Where the indexer should start scanning. BOT Chain adds ~128k blocks a day,
    // so this must be the deploy block, never 0.
    deployBlock: startBlock,
    escrowToken: token,
    minStakeWei: token.native ? minStakeWei.toString() : undefined,
    contracts: { ...(token.address ? { usdc: token.address } : {}), ...deployed, ...carried },
  };

  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    // Never silently overwrite a previous deployment's record.
    const backup = file.replace(/\.json$/, `.${Date.now()}.json`);
    fs.copyFileSync(file, backup);
    console.log(`\n Previous artifact backed up → ${path.relative(process.cwd(), backup)}`);
  }
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");

  console.log("\n─────────────────────────────────────────────");
  console.log(` Wrote ${path.relative(process.cwd(), file)}`);
  console.log("─────────────────────────────────────────────");
  console.log("\nNext steps:");
  console.log(`  1. Paste these into src/lib/networks/botchain.ts (contracts + indexFromBlock) and set deployed: true:\n`);
  for (const [k, v] of Object.entries(artifact.contracts)) console.log(`     ${k}: "${v}",`);
  console.log(`     indexFromBlock: ${startBlock},`);
  console.log(`\n  2. Verify on ${target.explorer}:`);
  console.log(
    `     npx hardhat verify --network ${network.name} ${deployed.usdcEscrow}${token.native ? "" : ` ${token.address}`}`,
  );
  console.log(`     (…and the rest — see DEPLOYMENT notes in SETUP.md)`);
  console.log(`\n  3. Point the runtime at it: SWARM_NETWORKS=arc-testnet,${target.id}\n`);

  void run;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
