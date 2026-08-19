/**
 * Deploy ERC-8004 registries (Identity / Reputation / Validation) for Polaris.
 *
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/deploy-erc8004.cjs --network bot_testnet
 *
 * WHY POLARIS DEPLOYS ITS OWN: the canonical ERC-8004 deployment isn't usable on
 * BOT Chain. On mainnet the vanity addresses (0x8004A…/0x8004B…/0x8004C…) are
 * ERC-1967 proxies still delegating to a `MinimalUUPSMainnet` placeholder — every
 * registry call reverts — and the upgrade that would activate them is signed by the
 * standard's owner key, which Polaris does not hold. BOT testnet has no deployment
 * at all. So these are the same reference implementations, deployed at Polaris's own
 * addresses: interface-compliant, non-canonical addresses. If the canonical proxies
 * are ever activated, pointing Polaris at them is a config change (see
 * src/lib/networks/ and server/networks.js).
 *
 * Flow per registry (mirrors the standard's own two-step, minus the vanity salts):
 *   1. proxy = ERC1967Proxy(PolarisUUPSBootstrap, initialize(owner, identity))
 *      — the registries' own initialize() is `onlyOwner`, so an owner must exist first
 *   2. proxy.upgradeToAndCall(realImplementation, initialize(...))
 *
 * Writes the addresses into deployments/<network>/erc8004.json, and merges them into
 * contracts.json so the runtime picks them up without env edits.
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const NETWORK_IDS = {
  arc_testnet: "arc-testnet",
  bot_testnet: "botchain-testnet",
  bot_mainnet: "botchain-mainnet",
};

const EXPECTED_CHAIN_IDS = { arc_testnet: 5042002, bot_testnet: 968, bot_mainnet: 677 };

function abort(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const networkId = NETWORK_IDS[network.name];
  if (!networkId) abort(`Unknown network "${network.name}". Known: ${Object.keys(NETWORK_IDS).join(", ")}`);

  const live = Number((await ethers.provider.getNetwork()).chainId);
  if (live !== EXPECTED_CHAIN_IDS[network.name]) {
    abort(`Chain id mismatch — RPC reports ${live}, expected ${EXPECTED_CHAIN_IDS[network.name]}.`);
  }
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    abort(`Set CONFIRM_DEPLOY=${network.name} to confirm.`);
  }

  const [deployer] = await ethers.getSigners();
  const owner = process.env.ERC8004_OWNER || deployer.address;
  console.log(`\nERC-8004 → ${networkId} (chain ${live})`);
  console.log(` Deployer : ${deployer.address}`);
  console.log(` Owner    : ${owner}\n`);

  /*
   * RESUMABLE. This script used to deploy the bootstrap and all three implementations
   * unconditionally, so a run that died partway left orphaned contracts on chain and a
   * retry paid for them a second time. That happened on BOT mainnet: a first attempt got
   * through the bootstrap and two implementations, then stopped before writing any
   * artifact, stranding 0.124 BOT. Re-running from scratch would have burned the same
   * again and left too little to operate the runtime.
   *
   * So each piece can be supplied by address and reused. Reuse is verified rather than
   * trusted: the address must have code, and the whole deployment is still checked at the
   * end (name(), symbol(), getIdentityRegistry()), so a wrong address fails loudly before
   * anything is written.
   *
   *   ERC8004_BOOTSTRAP / ERC8004_IMPL_IDENTITY / ERC8004_IMPL_REPUTATION /
   *   ERC8004_IMPL_VALIDATION
   */
  async function reuseOrDeploy(label, contractName, envVar) {
    const given = process.env[envVar];
    if (given) {
      if (!ethers.isAddress(given)) abort(`${envVar}="${given}" is not an address.`);
      if ((await ethers.provider.getCode(given)) === "0x") abort(`${envVar}=${given} has no code on this chain.`);
      console.log(` ${label.padEnd(20)} ${given}  (reused via ${envVar})`);
      return given;
    }
    const c = await ethers.deployContract(contractName);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    console.log(` ${label.padEnd(20)} ${addr}`);
    return addr;
  }

  // Shared bootstrap placeholder + the three real implementations.
  const bootstrapAddr = await reuseOrDeploy("Bootstrap", "PolarisUUPSBootstrap", "ERC8004_BOOTSTRAP");
  const bootstrap = await ethers.getContractAt("PolarisUUPSBootstrap", bootstrapAddr);

  const IMPL_ENV = {
    IdentityRegistryUpgradeable: "ERC8004_IMPL_IDENTITY",
    ReputationRegistryUpgradeable: "ERC8004_IMPL_REPUTATION",
    ValidationRegistryUpgradeable: "ERC8004_IMPL_VALIDATION",
  };
  const impls = {};
  for (const [name, envVar] of Object.entries(IMPL_ENV)) {
    impls[name] = await reuseOrDeploy(`impl ${name.replace("Upgradeable", "")}`, name, envVar);
  }

  /** proxy → bootstrap (owner set) → upgrade to the real implementation. */
  async function deployRegistry(label, implName, identityRegistry, initArgs) {
    const initBootstrap = bootstrap.interface.encodeFunctionData("initialize", [owner, identityRegistry]);
    const proxy = await ethers.deployContract("contracts/erc8004/ERC1967Proxy.sol:ERC1967Proxy", [bootstrapAddr, initBootstrap]);
    await proxy.waitForDeployment();
    const addr = await proxy.getAddress();

    const impl = await ethers.getContractAt(implName, addr);
    const initReal = impl.interface.encodeFunctionData("initialize", initArgs);
    const uups = await ethers.getContractAt("PolarisUUPSBootstrap", addr);
    await (await uups.upgradeToAndCall(impls[implName], initReal)).wait();

    console.log(` ${label.padEnd(20)} ${addr}`);
    return addr;
  }

  const ZERO = ethers.ZeroAddress;
  // Identity first — the other two need its address.
  const identity = await deployRegistry("IdentityRegistry", "IdentityRegistryUpgradeable", ZERO, []);
  const reputation = await deployRegistry("ReputationRegistry", "ReputationRegistryUpgradeable", identity, [identity]);
  const validation = await deployRegistry("ValidationRegistry", "ValidationRegistryUpgradeable", identity, [identity]);

  // Prove the deployment actually works rather than assuming it did.
  const id = await ethers.getContractAt("IdentityRegistryUpgradeable", identity);
  const name = await id.name();
  const symbol = await id.symbol();
  if (name !== "AgentIdentity") abort(`IdentityRegistry.name() returned "${name}", expected "AgentIdentity" — initialize didn't run.`);
  console.log(`\n ✓ IdentityRegistry live: name="${name}" symbol="${symbol}" (ERC-721 agent identities)`);

  const rep = await ethers.getContractAt("ReputationRegistryUpgradeable", reputation);
  const val = await ethers.getContractAt("ValidationRegistryUpgradeable", validation);
  if ((await rep.getIdentityRegistry()) !== identity) abort("ReputationRegistry points at the wrong identity registry");
  if ((await val.getIdentityRegistry()) !== identity) abort("ValidationRegistry points at the wrong identity registry");
  console.log(" ✓ Reputation + Validation bound to the Identity registry");

  /* ── Artifacts ────────────────────────────────────────────────────────────── */
  const addresses = {
    erc8004Identity: identity,
    erc8004Reputation: reputation,
    erc8004Validation: validation,
  };
  const dir = path.join(__dirname, "..", "..", "deployments", networkId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "erc8004.json"),
    JSON.stringify(
      {
        network: networkId,
        chainId: live,
        provenance: "polaris-deployed",
        note: "Reference ERC-8004 implementations at Polaris-owned addresses; the canonical vanity proxies on this chain are inactive placeholders.",
        deployedAtIso: new Date().toISOString(),
        owner,
        bootstrap: bootstrapAddr,
        implementations: impls,
        ...addresses,
      },
      null,
      2,
    ) + "\n",
  );

  // Merge into contracts.json so the backend reads them with no env edits.
  const contractsFile = path.join(dir, "contracts.json");
  if (fs.existsSync(contractsFile)) {
    const json = JSON.parse(fs.readFileSync(contractsFile, "utf8"));
    json.contracts = { ...json.contracts, ...addresses };
    fs.writeFileSync(contractsFile, JSON.stringify(json, null, 2) + "\n");
    console.log(` ✓ merged into ${path.relative(process.cwd(), contractsFile)}`);
  } else {
    console.log(` ! ${path.relative(process.cwd(), contractsFile)} not found — run deploy-network.cjs first, or set the BOT_ERC8004_* env vars.`);
  }

  console.log(`\nAlso add to src/lib/networks/botchain.ts:\n`);
  console.log(`  erc8004: {`);
  console.log(`    identity: "${identity}",`);
  console.log(`    reputation: "${reputation}",`);
  console.log(`    validation: "${validation}",`);
  console.log(`    provenance: "polaris-deployed",`);
  console.log(`  },\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
