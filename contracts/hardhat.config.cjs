require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/**
 * Arc Testnet — Circle's stablecoin-native L1.
 * Verified params: chainId 5042002, RPC https://rpc.testnet.arc.network,
 * explorer https://testnet.arcscan.app (Blockscout).
 * USDC is the native gas token.
 *
 * Contract verification uses Blockscout's Etherscan-compatible API (no key needed).
 */
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

/** BOT Chain may use its own deployer key; falls back to the shared one. */
function botKey() {
  return process.env.BOT_DEPLOYER_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY;
}

/** @type {import('hardhat/config').HardhatUserConfig} */
/**
 * The ERC-8004 reference registries (vendored under contracts/erc8004/) don't fit
 * in the legacy codegen's stack — `ReputationRegistryUpgradeable.giveFeedback`
 * overflows it. They need viaIR, but enabling viaIR globally would change the
 * bytecode of every Polaris contract, breaking byte-parity with what's deployed and
 * verified on Arc. So viaIR is applied per file, to the vendored contracts only.
 */
const ERC8004_SETTINGS = {
  version: "0.8.26",
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    viaIR: true,
  },
};

module.exports = {
  solidity: {
    // NOTE: the `compilers` array form is required for `overrides` to take effect —
    // Hardhat silently ignores `overrides` next to a top-level `version`. Settings
    // here are identical to before, so every non-ERC-8004 contract still compiles
    // byte-for-byte as the deployed-and-verified Arc contracts did.
    compilers: [
      {
        version: "0.8.26",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
        },
      },
    ],
    overrides: {
      "contracts/erc8004/IdentityRegistryUpgradeable.sol": ERC8004_SETTINGS,
      "contracts/erc8004/ReputationRegistryUpgradeable.sol": ERC8004_SETTINGS,
      "contracts/erc8004/ValidationRegistryUpgradeable.sol": ERC8004_SETTINGS,
    },
  },
  networks: {
    hardhat: {},
    arc_testnet: {
      url: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    /**
     * BOT Chain — EVM-compatible BNB-family L1 (Parlia, ~0.67s blocks, flat
     * 20 gwei gas paid in native BOT). Chain ids verified live via eth_chainId:
     * testnet 968 ("Bohr"), mainnet 677. Explorers are Blockscout, so the same
     * keyless verification flow Arc uses works here.
     *
     * A separate deployer key per network is supported (and recommended for
     * mainnet, which is real money) via BOT_DEPLOYER_PRIVATE_KEY.
     */
    bot_testnet: {
      url: process.env.BOT_TESTNET_RPC_URL || "https://rpc.bohr.life",
      chainId: 968,
      accounts: botKey() ? [botKey()] : [],
    },
    bot_mainnet: {
      url: process.env.BOT_MAINNET_RPC_URL || "https://rpc.botchain.ai",
      chainId: 677,
      accounts: botKey() ? [botKey()] : [],
    },
  },
  etherscan: {
    // Blockscout ignores the key value on all three of these.
    apiKey: { arc_testnet: "blockscout", bot_testnet: "blockscout", bot_mainnet: "blockscout" },
    customChains: [
      {
        network: "arc_testnet",
        chainId: 5042002,
        urls: {
          apiURL: "https://testnet.arcscan.app/api",
          browserURL: "https://testnet.arcscan.app",
        },
      },
      {
        network: "bot_testnet",
        chainId: 968,
        urls: {
          apiURL: "https://scan.bohr.life/api",
          browserURL: "https://scan.bohr.life",
        },
      },
      {
        network: "bot_mainnet",
        chainId: 677,
        urls: {
          apiURL: "https://scan.botchain.ai/api",
          browserURL: "https://scan.botchain.ai",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
