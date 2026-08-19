const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const ENTRY_POINT = require("./fixtures/entrypoint-v07.json");

/**
 * ERC-4337 account + factory, against the real EntryPoint v0.7 bytecode.
 *
 * These run on a local chain with the canonical EntryPoint deployed from its
 * on-chain code, so validation, prefunding and handleOps are exercised for real
 * rather than mocked.
 */
describe("PolarisAccount (ERC-4337 v0.7)", () => {
  // NOTE: the factory's view is called by explicit signature throughout. ethers'
  // BaseContract.getAddress() returns the CONTRACT's own address and shadows the
  // Solidity getAddress(address,uint256), so `factory.getAddress(owner, salt)`
  // silently answers with the factory's address instead of the account's.
  let owner, relayer, other, entryPoint, factory;

  before(async () => {
    [owner, relayer, other] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // Run against the REAL EntryPoint v0.7: its runtime bytecode is read from BOT
    // Chain (see test/fixtures/entrypoint-v07.json) and injected at the canonical
    // address, so validation, prefunding and handleOps behave exactly as they do on
    // the live network instead of against a mock that agrees with our assumptions.
    await network.provider.send("hardhat_setCode", [ENTRY_POINT.address, ENTRY_POINT.code]);
    entryPoint = await ethers.getContractAt(
      [
        "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
        "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
        "function getNonce(address sender, uint192 key) view returns (uint256)",
        "function balanceOf(address account) view returns (uint256)",
        "function depositTo(address account) payable",
        "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
      ],
      ENTRY_POINT.address,
    );
    factory = await ethers.deployContract("PolarisAccountFactory", [ENTRY_POINT.address]);
  });

  it("predicts the account address before deployment, and deploys there", async () => {
    const predicted = await factory["getAddress(address,uint256)"](owner.address, 0);
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");
    await factory.createAccount(owner.address, 0);
    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    const acct = await ethers.getContractAt("PolarisAccount", predicted);
    expect(await acct.owner()).to.equal(owner.address);
  });

  it("is idempotent, so a replayed initCode does not revert", async () => {
    const a = await factory.createAccount(owner.address, 0);
    await a.wait();
    await factory.createAccount(owner.address, 0); // must not throw
    expect(await factory["getAddress(address,uint256)"](owner.address, 0)).to.be.properAddress;
  });

  it("gives different owners different addresses", async () => {
    expect(await factory["getAddress(address,uint256)"](owner.address, 0)).to.not.equal(await factory["getAddress(address,uint256)"](other.address, 0));
  });

  it("accepts validateUserOp only from the EntryPoint", async () => {
    await factory.createAccount(owner.address, 0);
    const acct = await ethers.getContractAt("PolarisAccount", await factory["getAddress(address,uint256)"](owner.address, 0));
    const op = {
      sender: await acct.getAddress(), nonce: 0, initCode: "0x", callData: "0x",
      accountGasLimits: ethers.solidityPacked(["uint128","uint128"],[100000,100000]),
      preVerificationGas: 0,
      gasFees: ethers.solidityPacked(["uint128","uint128"],[0,0]),
      paymasterAndData: "0x", signature: "0x",
    };
    await expect(acct.connect(other).validateUserOp(op, ethers.ZeroHash, 0)).to.be.revertedWithCustomError(acct, "NotFromEntryPoint");
  });

  it("lets the owner execute directly, so a bundler outage cannot strand an agent", async () => {
    await factory.createAccount(owner.address, 0);
    const addr = await factory["getAddress(address,uint256)"](owner.address, 0);
    const acct = await ethers.getContractAt("PolarisAccount", addr);
    await owner.sendTransaction({ to: addr, value: ethers.parseEther("1") });
    const before = await ethers.provider.getBalance(other.address);
    await acct.connect(owner).execute(other.address, ethers.parseEther("0.5"), "0x");
    expect(await ethers.provider.getBalance(other.address)).to.equal(before + ethers.parseEther("0.5"));
  });

  it("refuses execute from anyone else", async () => {
    await factory.createAccount(owner.address, 0);
    const acct = await ethers.getContractAt("PolarisAccount", await factory["getAddress(address,uint256)"](owner.address, 0));
    await expect(acct.connect(other).execute(other.address, 0, "0x")).to.be.revertedWithCustomError(acct, "NotOwnerOrEntryPoint");
  });

  it("executes a batch atomically: one bad call reverts the whole thing", async () => {
    await factory.createAccount(owner.address, 0);
    const addr = await factory["getAddress(address,uint256)"](owner.address, 0);
    const acct = await ethers.getContractAt("PolarisAccount", addr);
    await owner.sendTransaction({ to: addr, value: ethers.parseEther("1") });
    const reverter = await ethers.deployContract("AlwaysReverts");
    const before = await ethers.provider.getBalance(other.address);
    await expect(
      acct.connect(owner).executeBatch(
        [other.address, await reverter.getAddress()],
        [ethers.parseEther("0.1"), 0],
        ["0x", reverter.interface.encodeFunctionData("boom")],
      ),
    ).to.be.reverted;
    // The first transfer must have been rolled back with the second call.
    expect(await ethers.provider.getBalance(other.address)).to.equal(before);
  });
});

describe("PolarisAccount ERC-1271", () => {
  let owner, other, factory;

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();
    await network.provider.send("hardhat_setCode", [ENTRY_POINT.address, ENTRY_POINT.code]);
    factory = await ethers.deployContract("PolarisAccountFactory", [ENTRY_POINT.address]);
    await factory.createAccount(owner.address, 0);
  });

  /**
   * This is what lets an agent acting through an account prove it authored its own
   * deliverable: a contract cannot ECDSA-sign, so server/auth.js falls back to
   * ERC-1271. Without this the backend would reject every submission from a
   * smart-account agent.
   */
  it("accepts the owner's personal_sign over a message", async () => {
    const addr = await factory["getAddress(address,uint256)"](owner.address, 0);
    const acct = await ethers.getContractAt(
      ["function isValidSignature(bytes32,bytes) view returns (bytes4)"],
      addr,
    );
    const message = "polaris-deliverable:0xabc";
    const signature = await owner.signMessage(message);
    expect(await acct.isValidSignature(ethers.hashMessage(message), signature)).to.equal("0x1626ba7e");
  });

  it("rejects a signature from anyone else", async () => {
    const addr = await factory["getAddress(address,uint256)"](owner.address, 0);
    const acct = await ethers.getContractAt(
      ["function isValidSignature(bytes32,bytes) view returns (bytes4)"],
      addr,
    );
    const message = "polaris-deliverable:0xabc";
    expect(await acct.isValidSignature(ethers.hashMessage(message), await other.signMessage(message))).to.equal("0xffffffff");
  });
});

describe("PolarisAccount as an ERC-721 holder", () => {
  /**
   * An ERC-8004 identity is an ERC-721 minted with _safeMint, so an account that
   * cannot receive one can never own its own identity. This failed on live chain
   * with ERC721InvalidReceiver before onERC721Received existed.
   */
  it("can be minted an ERC-721, which an ERC-8004 identity is", async () => {
    const [owner] = await ethers.getSigners();
    await network.provider.send("hardhat_setCode", [ENTRY_POINT.address, ENTRY_POINT.code]);
    const factory = await ethers.deployContract("PolarisAccountFactory", [ENTRY_POINT.address]);
    await factory.createAccount(owner.address, 0);
    const account = await factory["getAddress(address,uint256)"](owner.address, 0);

    const nft = await ethers.deployContract("TestSafeMintNFT");
    await nft.safeMintTo(account, 1);
    expect(await nft.ownerOf(1)).to.equal(account);
  });
});
