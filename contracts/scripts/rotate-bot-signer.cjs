/**
 * Give a BOT Chain deployment its own verdict signer, separate from the deployer/owner key.
 *
 * A fresh deployment makes one key the contract owner, the verdict signer, the treasury,
 * the 4337 relayer and the ERC-8004 validator at once. Compromising it means being able to
 * release or slash every escrow on that chain, and the key has to sit in plaintext env on
 * an always-online service. Splitting the *signer* is the highest-value single step: a
 * leaked signer can forge verdicts on one chain and nothing else, because it cannot
 * re-point the contracts. Ownership stays with the deployer.
 *
 * What this does:
 *   1. derives a fresh signer from NEW_SIGNER_KEY;
 *   2. points VerifierBridge and the three native extensions at it;
 *   3. reads each back to prove the rotation landed.
 *
 * The runtime must already have the new key in its env, otherwise settlements fail
 * between this run and the next deploy.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet NEW_SIGNER_KEY=0x… \
 *     npx hardhat run scripts/rotate-bot-signer.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const SETTERS = [
  ["verifierBridge", "VerifierBridge"],
  ["subscriptionManager", "NativeSubscriptionManager"],
  ["recurringMarket", "NativeRecurringMarket"],
  ["disputeManager", "NativeDisputeManager"],
];

/** The runtime env var that must carry the new key, named per network. */
function envVarFor(networkId) {
  return `BOT_VERIFIER_SIGNER_KEY_${networkId.replace(/-/g, "_").toUpperCase()}`;
}

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) throw new Error(`Set CONFIRM_DEPLOY=${network.name}.`);
  const keyIn = process.env.NEW_SIGNER_KEY;
  if (!keyIn) throw new Error("Set NEW_SIGNER_KEY to the new verdict signer's private key.");
  const newSigner = new ethers.Wallet(keyIn).address;

  // Derived from the hardhat network rather than hardcoded, so the same rotation works on
  // mainnet. Reading testnet's artifact while pointed at mainnet would rotate signers on
  // addresses that do not exist there, and report success for every skipped contract.
  const NETWORK_IDS = { bot_testnet: "botchain-testnet", bot_mainnet: "botchain-mainnet" };
  const networkId = NETWORK_IDS[network.name];
  if (!networkId) throw new Error(`Unknown network "${network.name}". Known: ${Object.keys(NETWORK_IDS).join(", ")}`);
  const file = path.join(__dirname, "..", "..", "deployments", networkId, "contracts.json");
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = artifact.contracts;
  const [owner] = await ethers.getSigners();

  console.log(`\nRotating the verdict signer on ${networkId}`);
  console.log(` owner (unchanged) : ${owner.address}`);
  console.log(` old signer        : ${artifact.verifierSigner}`);
  console.log(` new signer        : ${newSigner}`);
  if (newSigner.toLowerCase() === owner.address.toLowerCase()) {
    throw new Error("The new signer is the owner again, which defeats the point of splitting them.");
  }

  const ABI = [
    "function setTrustedSigner(address) external",
    "function trustedSigner() view returns (address)",
  ];

  for (const [key, label] of SETTERS) {
    const addr = c[key];
    if (!addr) {
      console.log(`  ${label.padEnd(26)} not deployed, skipped`);
      continue;
    }
    const inst = new ethers.Contract(addr, ABI, owner);
    const before = await inst.trustedSigner();
    if (before.toLowerCase() === newSigner.toLowerCase()) {
      console.log(`  ${label.padEnd(26)} already rotated`);
      continue;
    }
    await (await inst.setTrustedSigner(newSigner)).wait();
    const after = await inst.trustedSigner();
    if (after.toLowerCase() !== newSigner.toLowerCase()) {
      throw new Error(`${label} still trusts ${after}`);
    }
    console.log(`  ${label.padEnd(26)} ${before} -> ${after}`);
  }

  artifact.verifierSigner = newSigner;
  artifact.signerRotatedAtIso = new Date().toISOString();
  // The owner keeps ownership on purpose: a leaked signer must not be able to
  // re-point the contracts at itself.
  artifact.owner = owner.address;
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nArtifact updated. Set ${envVarFor(networkId)} on that runtime and redeploy.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
