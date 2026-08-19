/**
 * End-to-end smoke test of a live Polaris deployment.
 *
 *   npx hardhat run scripts/e2e-botchain.cjs --network bot_testnet
 *
 * Drives the whole market lifecycle against the REAL deployed contracts with a
 * throwaway agent wallet: fund → register → post task → bid → award → verify →
 * settle, then asserts the money actually moved and reputation actually changed.
 *
 * Works against either asset model, reading which one from the deployment
 * artifact: a native-coin market (BOT Chain) funds calls with msg.value and has no
 * approve step, an ERC-20 market (Arc) approves and pulls.
 *
 * The verdict is signed here with the verifier key, exactly as server/server.js
 * does (same digest, binding chain id + bridge address). The LLM scoring step is
 * deliberately not exercised — it's chain-agnostic and already runs on Arc; this
 * script is about proving the on-chain half works on this network.
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const NETWORK_IDS = { arc_testnet: "arc-testnet", bot_testnet: "botchain-testnet", bot_mainnet: "botchain-mainnet" };

function ok(label, cond, detail = "") {
  console.log(`${cond ? " ✓" : " ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

async function main() {
  const networkId = NETWORK_IDS[network.name];
  if (!networkId) throw new Error(`Unknown network ${network.name}`);
  if (network.name === "bot_mainnet") throw new Error("Refusing to run the e2e script against mainnet.");

  const file = path.join(__dirname, "..", "..", "deployments", networkId, "contracts.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = dep.contracts;
  const native = Boolean(dep.escrowToken.native);
  const dec = dep.escrowToken.decimals;
  const sym = dep.escrowToken.symbol;
  const amt = (n) => ethers.parseUnits(String(n), dec);

  // Sized off the deployed stake floor so this works at any configured floor.
  const stake = dep.minStakeWei ? BigInt(dep.minStakeWei) : amt(100);
  const budget = native ? amt("0.1") : amt(10);
  const bid = native ? amt("0.08") : amt(8);

  const [requester] = await ethers.getSigners();
  const agent = ethers.Wallet.createRandom().connect(ethers.provider);

  console.log(`\nPolaris e2e — ${dep.label} (chain ${dep.chainId})`);
  console.log(` Asset     : ${sym} (${dec} dec) ${native ? "· NATIVE, value sent with each call" : `· ERC-20 at ${c.usdc}`}`);
  console.log(` Stake     : ${ethers.formatUnits(stake, dec)} ${sym}`);
  console.log(` Requester : ${requester.address}`);
  console.log(` Agent     : ${agent.address} (throwaway)\n`);

  const registry = await ethers.getContractAt(native ? "NativeAgentRegistry" : "AgentRegistry", c.agentRegistry);
  const taskReg = await ethers.getContractAt(native ? "NativeTaskRegistry" : "TaskRegistry", c.taskRegistry);
  const bidEngine = await ethers.getContractAt("BidEngine", c.bidEngine);
  const bridge = await ethers.getContractAt("VerifierBridge", c.verifierBridge);
  const identity = c.erc8004Identity ? await ethers.getContractAt("IdentityRegistryUpgradeable", c.erc8004Identity) : null;
  const token = native
    ? null
    : await ethers.getContractAt(
        ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
        c.usdc,
      );

  const balanceOf = (a) => (native ? ethers.provider.getBalance(a) : token.balanceOf(a));
  const GAS = ethers.parseEther("0.05"); // headroom so the agent can pay for its own txs

  /* 1 ── fund the agent ──────────────────────────────────────────────────── */
  console.log("1. Funding the agent");
  if (native) {
    // Stake and gas are the same coin here, so send both in one transfer.
    await (await requester.sendTransaction({ to: agent.address, value: stake + GAS })).wait();
  } else {
    await (await requester.sendTransaction({ to: agent.address, value: GAS })).wait();
    await (await token.mint(agent.address, stake * 2n)).wait();
    await (await token.mint(requester.address, budget * 2n)).wait();
  }
  ok("agent can pay gas", (await ethers.provider.getBalance(agent.address)) > 0n);
  ok(`agent holds the stake in ${sym}`, (await balanceOf(agent.address)) >= stake);

  /* 2 ── register (stake) ────────────────────────────────────────────────── */
  console.log("\n2. Registering the agent on-chain");
  const agentId = ethers.keccak256(ethers.toUtf8Bytes(`e2e-agent:${agent.address.toLowerCase()}`));
  if (!native) await (await token.connect(agent).approve(c.agentRegistry, stake)).wait();
  await (
    await registry
      .connect(agent)
      .register(agentId, stake, "E2E-Tester", "research,general", native ? { value: stake } : {})
  ).wait();
  const info = await registry.agents(agent.address);
  ok("registered + staked", info.registered && info.stakedUsdc === stake, `${ethers.formatUnits(info.stakedUsdc, dec)} ${sym}`);
  ok("starts at reputation 100", Number(info.reputation) === 100);
  if (native) ok("stake is held by the registry as native value", (await ethers.provider.getBalance(c.agentRegistry)) >= stake);

  /* 2b ── ERC-8004 identity for the same wallet ──────────────────────────── */
  if (identity) {
    console.log("\n2b. Issuing the agent an ERC-8004 identity");
    const rc = await (await identity.connect(agent)["register(string)"](`https://polarisswarm.xyz/agents/${agent.address}`)).wait();
    const ev = rc.logs
      .map((l) => {
        try {
          return identity.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "Registered");
    const erc8004Id = ev.args.agentId;
    const boundWallet = await identity.getMetadata(erc8004Id, "agentWallet");
    ok("ERC-8004 identity minted", (await identity.ownerOf(erc8004Id)) === agent.address, `agentId ${erc8004Id}`);
    ok("agentWallet binds to the wallet Polaris registered", boundWallet.toLowerCase() === agent.address.toLowerCase());
  }

  /* 3 ── post a task ─────────────────────────────────────────────────────── */
  console.log("\n3. Posting a task");
  const taskId = ethers.hexlify(ethers.randomBytes(32));
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  if (!native) await (await token.approve(c.usdcEscrow, budget)).wait();
  await (
    await taskReg.submitTask(
      taskId,
      budget,
      deadline,
      70,
      "E2E smoke task",
      "Prove the market works on this network.",
      "Must exist.",
      "research",
      native ? { value: budget } : {},
    )
  ).wait();
  let t = await taskReg.tasks(taskId);
  ok("task is OPEN with the budget escrowed", Number(t.status) === 0 && t.budgetUsdc === budget);
  ok("escrow holds the budget", (await balanceOf(c.usdcEscrow)) >= budget, `${ethers.formatUnits(budget, dec)} ${sym}`);
  if (native) console.log("   (one transaction — no approve step on a native network)");

  /* 4 ── bid + award ─────────────────────────────────────────────────────── */
  console.log("\n4. Bidding and awarding");
  await (await bidEngine.connect(agent).placeBid(taskId, bid, 1800)).wait();
  ok("bid recorded", Number(await bidEngine.bidCount(taskId)) === 1);
  await (await bidEngine.connect(agent).awardBid(taskId)).wait();
  t = await taskReg.tasks(taskId);
  ok(
    "task ASSIGNED to the agent",
    Number(t.status) === 1 && t.assignedAgent === agent.address,
    `winning bid ${ethers.formatUnits(t.winningBid, dec)} ${sym}`,
  );

  /* 5 ── verify + settle (verifier-signed verdict) ───────────────────────── */
  console.log("\n5. Settling with a verifier-signed verdict");
  const deliverable = "E2E deliverable produced for the smoke test.";
  const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes(deliverable));
  const score = 88;
  // Byte-for-byte the digest server/server.js builds: chain id + bridge address +
  // task + agent + requester + verdict. A verdict signed for another network
  // cannot recover here.
  const digest = ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "address", "address", "bool", "uint8", "bytes32"],
    [dep.chainId, c.verifierBridge, taskId, agent.address, requester.address, true, score, deliverableHash],
  );
  const signature = await requester.signMessage(ethers.getBytes(digest));

  const agentBefore = await balanceOf(agent.address);
  const reqBefore = await balanceOf(requester.address);
  const rc = await (
    await bridge.submitVerification(taskId, agent.address, requester.address, true, score, deliverableHash, signature)
  ).wait();
  // The requester pays this transaction's gas, and on a native network that gas
  // comes out of the very balance we're measuring — so add it back.
  const gasPaid = rc.gasUsed * rc.gasPrice;

  const agentAfter = await balanceOf(agent.address);
  const reqAfter = await balanceOf(requester.address);
  t = await taskReg.tasks(taskId);
  const after = await registry.agents(agent.address);
  const att = await bridge.getAttestation(taskId);

  ok("task SETTLED", Number(t.status) === 4);
  ok("agent paid its winning bid", agentAfter - agentBefore === bid, `+${ethers.formatUnits(agentAfter - agentBefore, dec)} ${sym}`);
  const reqDelta = reqAfter - reqBefore + (native ? gasPaid : 0n);
  ok("requester refunded the difference", reqDelta === budget - bid, `+${ethers.formatUnits(reqDelta, dec)} ${sym}`);
  ok("reputation increased", Number(after.reputation) === 110, `100 → ${after.reputation}`);
  ok("agent freed (activeTasks back to 0)", Number(after.activeTasks) === 0);
  ok("attestation stored on-chain", att.passed && Number(att.score) === score && att.deliverableHash === deliverableHash);
  ok("escrow drained for this task", (await balanceOf(c.usdcEscrow)) === 0n);

  console.log(`\nExplorer: ${dep.explorer}/address/${c.taskRegistry}`);
  console.log(process.exitCode ? "\n✗ E2E FAILED\n" : "\n✓ E2E PASSED — full lifecycle works on this network\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
