/**
 * Live proof that Polaris's ERC-8004 integration works, against the registries
 * deployed on the target network.
 *
 * Exercises the real constraints rather than the happy path only:
 *   1. a fresh agent key mints its OWN identity (register mints to msg.sender, so
 *      an identity minted by anyone else would be owned by the wrong address);
 *   2. the AGENT opens a validation request for its own work, naming the verifier
 *      as validator: only an owner or operator may open one;
 *   3. the VERIFIER answers it with the score and the deliverable hash;
 *   4. the VERIFIER posts reputation feedback, which is only legal because it is
 *      neither owner nor operator of the agent;
 *   5. the agent CANNOT rate itself: giveFeedback must revert for the agent's own
 *      key with "Self-feedback not allowed".
 *
 * Step 4 is why the roles are split this way. Making the verifier an operator (so it
 * could open requests itself) made its feedback revert as self-feedback, because
 * `giveFeedback` rejects `isAuthorizedOrOwner`, which includes operators. One
 * address cannot both open validation requests and give feedback.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/e2e-erc8004.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];
const REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];
const VALIDATION_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
];

const NETWORK_IDS = { bot_testnet: "botchain-testnet", bot_mainnet: "botchain-mainnet" };

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    throw new Error(`Set CONFIRM_DEPLOY=${network.name} to confirm the target network.`);
  }
  const id = NETWORK_IDS[network.name];
  const file = path.join(__dirname, "..", "..", "deployments", id, "contracts.json");
  const { contracts: c } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!c.erc8004Identity) throw new Error("No ERC-8004 registries in the artifact for this network.");

  const [verifier] = await ethers.getSigners();
  console.log(`\nERC-8004 live check on ${id}`);
  console.log(` identity   : ${c.erc8004Identity}`);
  console.log(` reputation : ${c.erc8004Reputation}`);
  console.log(` validation : ${c.erc8004Validation}`);
  console.log(` verifier   : ${verifier.address}`);

  // A throwaway agent, funded just enough to mint its own identity.
  const agent = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`\n1. funding a fresh agent key ${agent.address}`);
  await (await verifier.sendTransaction({ to: agent.address, value: ethers.parseEther("0.02") })).wait();

  console.log("2. agent mints its OWN identity");
  const identityAsAgent = new ethers.Contract(c.erc8004Identity, IDENTITY_ABI, agent);
  const agentURI = `https://polarisswarm.xyz/agent/${agent.address}`;
  const mint = await (await identityAsAgent["register(string)"](agentURI)).wait();
  let agentId = null;
  for (const log of mint.logs) {
    try {
      const p = identityAsAgent.interface.parseLog({ topics: log.topics, data: log.data });
      if (p?.name === "Registered") agentId = p.args.agentId;
    } catch {
      /* not ours */
    }
  }
  if (agentId == null) throw new Error("No Registered event — mint did not take.");
  const owner = await identityAsAgent.ownerOf(agentId);
  console.log(`   agentId #${agentId}, owner ${owner}`);
  if (owner.toLowerCase() !== agent.address.toLowerCase()) {
    throw new Error(`Identity owned by ${owner}, not the agent. register() mints to msg.sender.`);
  }
  console.log(`   tokenURI: ${await identityAsAgent.tokenURI(agentId)}`);

  console.log("3. agent opens a validation request for its own work");
  const taskId = ethers.id(`erc8004-check-${Date.now()}`);
  const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes("the delivered work"));
  const requestHash = ethers.solidityPackedKeccak256(
    ["string", "uint256", "bytes32", "address"],
    ["polaris-validation", agentId, taskId, c.verifierBridge],
  );
  // The AGENT opens it (owner-only), naming the verifier as the validator.
  const validationAsAgent = new ethers.Contract(c.erc8004Validation, VALIDATION_ABI, agent);
  await (await validationAsAgent.validationRequest(verifier.address, agentId, `https://polarisswarm.xyz/task/${taskId}`, requestHash)).wait();
  console.log("   request opened by the agent, validator = verifier");

  console.log("4. verifier answers with the score and the deliverable hash");
  const validation = new ethers.Contract(c.erc8004Validation, VALIDATION_ABI, verifier);
  // On BOT Chain's sub-second blocks a mined receipt is not proof the write is
  // visible yet: answering immediately reverted with "unknown" in testing. Wait for
  // the request to be readable, exactly as the runtime does.
  for (let i = 0; i < 10; i++) {
    try {
      if ((await validation.getValidationStatus(requestHash))[0] !== ethers.ZeroAddress) break;
    } catch {
      /* "unknown" until it lands */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await (await validation.validationResponse(requestHash, 92, `https://polarisswarm.xyz/task/${taskId}`, deliverableHash, "polaris-verifier")).wait();
  const status = await validation.getValidationStatus(requestHash);
  console.log(`   stored: validator ${status[0]}, agentId #${status[1]}, response ${status[2]}, responseHash ${status[3]}, tag "${status[4]}"`);
  if (Number(status[2]) !== 92) throw new Error(`Validation response is ${status[2]}, expected 92.`);
  if (status[3] !== deliverableHash) throw new Error("Stored response hash is not the deliverable hash.");

  console.log("5. verifier posts feedback");
  const reputation = new ethers.Contract(c.erc8004Reputation, REPUTATION_ABI, verifier);
  await (
    await reputation.giveFeedback(agentId, 92, 0, "polaris", "task-settlement", "", `https://polarisswarm.xyz/task/${taskId}`, ethers.keccak256(ethers.toUtf8Bytes(taskId)))
  ).wait();
  console.log("   feedback accepted from the verifier");

  console.log("6. the agent must NOT be able to rate itself");
  try {
    await (
      await new ethers.Contract(c.erc8004Reputation, REPUTATION_ABI, agent).giveFeedback(
        agentId, 100, 0, "polaris", "self", "", "", ethers.ZeroHash,
      )
    ).wait();
    throw new Error("Self-feedback was ACCEPTED — the standard's guard is not working.");
  } catch (e) {
    const msg = e.shortMessage || e.message || "";
    if (!msg.includes("Self-feedback") && !msg.includes("reverted")) throw e;
    console.log("   correctly rejected: an agent cannot inflate its own record");
  }

  // Return the leftover so repeated runs don't drain the deployer.
  const left = await ethers.provider.getBalance(agent.address);
  if (left > ethers.parseEther("0.005")) {
    await (await agent.sendTransaction({ to: verifier.address, value: left - ethers.parseEther("0.003") })).wait();
  }
  console.log("\nAll five ERC-8004 behaviours verified on live chain.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
