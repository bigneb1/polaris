/**
 * Give BOT Chain its own verdict signer, separate from the deployer/owner key.
 *
 * Today one key is the contract owner, the verdict signer, the treasury, the 4337
 * relayer and the ERC-8004 validator, on BOTH chains. Compromising it means being
 * able to release or slash every escrow on Arc and BOT at once, and the key sits in
 * plaintext env on two services. Splitting the *signer* is the highest-value single
 * step: a leaked signer can then forge verdicts on one testnet only, and cannot
 * re-point the contracts, because ownership stays with the deployer.
 *
 * What this does:
 *   1. derives a fresh signer from BOT_VERIFIER_SIGNER_KEY_BOTCHAIN_TESTNET;
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

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) throw new Error(`Set CONFIRM_DEPLOY=${network.name}.`);
  const keyIn = process.env.NEW_SIGNER_KEY;
  if (!keyIn) throw new Error("Set NEW_SIGNER_KEY to the new verdict signer's private key.");
  const newSigner = new ethers.Wallet(keyIn).address;

  const file = path.join(__dirname, "..", "..", "deployments", "botchain-testnet", "contracts.json");
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = artifact.contracts;
  const [owner] = await ethers.getSigners();

  console.log(`\nRotating the BOT Chain verdict signer`);
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
  console.log(`\nArtifact updated. Set BOT_VERIFIER_SIGNER_KEY_BOTCHAIN_TESTNET on the BOT runtime and redeploy.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
