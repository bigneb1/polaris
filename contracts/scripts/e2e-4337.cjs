/**
 * Live proof that an agent can act through an ERC-4337 smart account on this
 * network, using the canonical EntryPoint v0.7 and Polaris's own bundling (there is
 * no public bundler on BOT Chain).
 *
 * The point is not "a UserOperation executed" in the abstract: the account performs
 * a real Polaris action, registering itself in the agent registry and staking, which
 * is the first thing any agent must do. If that works through the EntryPoint, the
 * account is a usable agent identity rather than a demo.
 *
 * Steps:
 *   1. derive the account address from the owner key (CREATE2, before deployment);
 *   2. deploy it and fund its EntryPoint deposit, which is what pays for its ops;
 *   3. send a UserOperation that calls NativeAgentRegistry.register, staking from
 *      the ACCOUNT's own balance;
 *   4. confirm on chain that the registry now knows the ACCOUNT (not the owner key)
 *      as a staked agent, and that the EntryPoint reported the op as successful.
 *
 * Usage:
 *   CONFIRM_DEPLOY=bot_testnet npx hardhat run scripts/e2e-4337.cjs --network bot_testnet
 */
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const NETWORK_IDS = { bot_testnet: "botchain-testnet", bot_mainnet: "botchain-mainnet" };

const EP_ABI = [
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function depositTo(address account) payable",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
];
const FACTORY_ABI = [
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
];
const ACCOUNT_ABI = ["function execute(address target, uint256 value, bytes data)", "function owner() view returns (address)"];
const REGISTRY_ABI = [
  "function register(bytes32 agentId, uint256 stakeAmount, string name, string capabilities) payable",
  "function agents(address) view returns (address wallet, bytes32 agentId, uint256 stakedUsdc, uint256 reputation, uint256 tasksCompleted, uint256 tasksFailed, uint256 activeTasks, bool online, bool registered)",
  "function MIN_STAKE() view returns (uint256)",
];

const pack = (hi, lo) => ethers.solidityPacked(["uint128", "uint128"], [hi, lo]);

async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) {
    throw new Error(`Set CONFIRM_DEPLOY=${network.name} to confirm the target network.`);
  }
  const id = NETWORK_IDS[network.name];
  const file = path.join(__dirname, "..", "..", "deployments", id, "contracts.json");
  const { contracts: c } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!c.accountFactory) throw new Error("No accountFactory in the artifact — run deploy-4337.cjs first.");

  const [relayer] = await ethers.getSigners();
  const ep = new ethers.Contract(c.entryPoint, EP_ABI, relayer);
  const factory = new ethers.Contract(c.accountFactory, FACTORY_ABI, relayer);
  const registry = new ethers.Contract(c.agentRegistry, REGISTRY_ABI, ethers.provider);
  const minStake = await registry.MIN_STAKE();

  console.log(`\nERC-4337 live check on ${id}`);
  console.log(` entryPoint : ${c.entryPoint}`);
  console.log(` factory    : ${c.accountFactory}`);
  console.log(` registry   : ${c.agentRegistry} (min stake ${ethers.formatEther(minStake)})`);
  console.log(` relayer    : ${relayer.address}`);

  // A fresh owner key, so the run is repeatable and proves the account is derived
  // from the key rather than pre-arranged.
  const ownerKey = ethers.Wallet.createRandom();
  console.log(`\n1. deriving the account address for a fresh owner ${ownerKey.address}`);
  // Explicit signature: ethers' BaseContract.getAddress() shadows the Solidity one.
  const account = await factory["getAddress(address,uint256)"](ownerKey.address, 0);
  console.log(`   counterfactual account: ${account}`);
  if ((await ethers.provider.getCode(account)) !== "0x") throw new Error("Account already exists — salt collision.");

  console.log("2. deploying it and funding its EntryPoint deposit");
  await (await factory.createAccount(ownerKey.address, 0)).wait();
  if ((await ethers.provider.getCode(account)) === "0x") throw new Error("Account was not deployed at the predicted address.");
  const acct = new ethers.Contract(account, ACCOUNT_ABI, ethers.provider);
  if ((await acct.owner()).toLowerCase() !== ownerKey.address.toLowerCase()) throw new Error("Account owner mismatch.");
  await (await ep.depositTo(account, { value: ethers.parseEther("0.03") })).wait();
  // The stake itself comes out of the account's own balance, not the deposit.
  await (await relayer.sendTransaction({ to: account, value: minStake })).wait();
  console.log(`   deposit ${ethers.formatEther(await ep.balanceOf(account))}, balance ${ethers.formatEther(await ethers.provider.getBalance(account))}`);

  console.log("3. sending a UserOperation: the account registers itself as an agent");
  const agentId = ethers.id(`aa-agent-${Date.now()}`);
  const registerData = registry.interface.encodeFunctionData("register", [agentId, minStake, "AA-Agent", "research"]);
  const callData = acct.interface.encodeFunctionData("execute", [c.agentRegistry, minStake, registerData]);

  // Estimate as the ENTRYPOINT, which is the caller that will actually run this:
  // `execute` rejects anyone else, so estimating with `from: account` reverts.
  let callGasLimit = 600000n;
  try {
    callGasLimit = (await ethers.provider.estimateGas({ from: c.entryPoint, to: account, data: callData })) + 80000n;
    console.log(`   inner call estimated at ${callGasLimit} gas`);
  } catch (e) {
    console.log(`   (inner estimate unavailable: ${e.shortMessage || e.message}; using ${callGasLimit})`);
  }
  const fee = await ethers.provider.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("20", "gwei");

  const userOp = {
    sender: account,
    nonce: await ep.getNonce(account, 0),
    initCode: "0x",
    callData,
    accountGasLimits: pack(300000n, callGasLimit),
    preVerificationGas: 100000n,
    gasFees: pack(fee.maxPriorityFeePerGas ?? 0n, maxFee),
    paymasterAndData: "0x",
    signature: "0x",
  };
  const userOpHash = await ep.getUserOpHash(userOp);
  userOp.signature = await ownerKey.signMessage(ethers.getBytes(userOpHash));

  const receipt = await (await ep.handleOps([userOp], relayer.address)).wait();
  let success = null;
  let gasCost = null;
  let revertReason = null;
  for (const log of receipt.logs) {
    try {
      const p = ep.interface.parseLog({ topics: log.topics, data: log.data });
      if (p?.name === "UserOperationEvent") {
        success = p.args.success;
        gasCost = p.args.actualGasCost;
      }
      if (p?.name === "UserOperationRevertReason") revertReason = p.args.revertReason;
    } catch {
      /* not an EntryPoint log */
    }
  }
  console.log(`   userOpHash ${userOpHash}`);
  console.log(`   tx ${receipt.hash}`);
  console.log(`   EntryPoint reported success=${success}, gas cost ${gasCost != null ? ethers.formatEther(gasCost) : "?"}`);
  if (revertReason && revertReason !== "0x") {
    let decoded = revertReason;
    try {
      decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + revertReason.slice(10))[0];
    } catch {
      /* not a string revert */
    }
    throw new Error(`Inner call reverted: ${decoded}`);
  }
  // handleOps can succeed as a transaction while the operation itself failed, so the
  // event's flag is what matters, not the receipt's status.
  if (success !== true) throw new Error("The UserOperation did not succeed.");

  console.log("4. confirming the registry knows the ACCOUNT as a staked agent");
  const info = await registry.agents(account);
  console.log(`   registered=${info.registered}, online=${info.online}, stake=${ethers.formatEther(info.stakedUsdc)}, reputation=${info.reputation}`);
  if (!info.registered) throw new Error("The registry does not have the account registered.");
  if (info.stakedUsdc < minStake) throw new Error("Stake is below the floor.");
  console.log(`   the agent on chain is the SMART ACCOUNT ${account}, not the owner key ${ownerKey.address}`);

  console.log("\nERC-4337 verified on live chain: a smart account did real Polaris work through the EntryPoint.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
