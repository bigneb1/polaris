import {
  botTestnet,
  botMainnet,
  BOT_TESTNET_RPC_URL,
  BOT_TESTNET_EXPLORER,
  BOT_TESTNET_CHAIN_ID,
  BOT_MAINNET_RPC_URL,
  BOT_MAINNET_EXPLORER,
  BOT_MAINNET_CHAIN_ID,
} from "./chains";
import { apiBase } from "./apiBase";
import type { NetworkConfig, SmartAccountConfig } from "./types";

/**
 * BOT Chain — Polaris's second network. Purely additive: nothing here touches
 * Arc.
 *
 * SETTLES IN NATIVE BOT. Budgets, bids and agent stakes are denominated in BOT
 * itself — the same coin that pays gas — not in a stablecoin. That means the
 * native-value contract set (NativeEscrow / NativeAgentRegistry /
 * NativeTaskRegistry, with BidEngine and VerifierBridge reused unchanged), value
 * arriving as `msg.value`, no approve step, and 18 decimals instead of 6.
 *
 * Because BOT is 18 decimals, the stake floor cannot be AgentRegistry's hardcoded
 * `100_000_000` (that would be 1e-10 BOT — no collateral at all), so
 * NativeAgentRegistry takes it as a constructor parameter. Testnet is deployed with
 * a **0.02 BOT** floor, chosen so registering an agent costs ~0.02 BOT all-in
 * (registration gas measured at 0.0034 BOT). At that size the stake is a spam gate
 * rather than meaningful collateral — a slash takes 10% of it — so the real
 * deterrent is reputation loss, not the forfeited amount.
 *
 * Subscriptions, the recurring market and staked disputes ARE available here: they
 * run on native-value twins (NativeSubscriptionManager / NativeRecurringMarket /
 * NativeDisputeManager) deployed alongside the core market. Only RevenueRouter,
 * which collects an ERC-20 protocol fee, has no native equivalent yet.
 *
 * Verified on-chain 2026-08-17 (not taken from documentation):
 *  - chain ids 968 (testnet) / 677 (mainnet) via eth_chainId
 *  - ERC-4337 EntryPoint v0.7 is deployed and byte-identical to the canonical
 *    contract on both networks (sha256 of eth_getCode matches Arc and Ethereum).
 *    v0.6 and v0.8 are absent, so v0.7 is the only version to target.
 *  - there is NO public bundler (`eth_supportedEntryPoints` → -32601) and no
 *    ERC-4337 paymaster. BOT Chain's own gas sponsorship is an EOA-based
 *    bundle/builder scheme explicitly distinct from EIP-4337's paymaster, so it
 *    is not a drop-in. Polaris therefore self-bundles: a relayer EOA calls
 *    EntryPoint.handleOps directly.
 *  - Circle has no presence at all (no Modular Wallets, no MPC agent wallets, no
 *    Gateway) → the human wallet here is Reown AppKit, and x402 is unavailable.
 */

/** Canonical ERC-4337 v0.7 EntryPoint — verified deployed on both BOT networks. */
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

/** No third-party bundler serves BOT Chain, so `bundlerUrl` stays null and
 *  UserOperations are submitted through EntryPoint.handleOps by our relayer. */
function smartAccount(accountFactory: `0x${string}` | null): SmartAccountConfig {
  return {
    entryPoint: ENTRY_POINT_V07,
    entryPointVersion: "0.7",
    accountFactory,
    bundlerUrl: null,
  };
}

export const botTestnetConfig: NetworkConfig = {
  id: "botchain-testnet",
  label: "BOT Chain Testnet",
  shortLabel: "BOT Testnet",
  chainId: BOT_TESTNET_CHAIN_ID,
  chain: botTestnet,
  rpcUrl: BOT_TESTNET_RPC_URL,
  explorerUrl: BOT_TESTNET_EXPLORER,
  explorerName: "BOTScan",
  testnet: true,
  accent: "bot",

  // Deployed 2026-08-18 by contracts/scripts/deploy-network.cjs.
  // Source of truth is deployments/botchain-testnet/contracts.json; mirrored here
  // because the frontend keeps addresses in source, never in env.
  contracts: {
    // No token contract: the escrow asset is the chain's native coin.
    usdc: null,
    usdcEscrow: "0x51d7b1fC88A9c1590C647A9B37fc9EC8Ea421fba", // NativeEscrow
    agentRegistry: "0xE06007c65E986bfD5Fe432A0F3cb697b436E36e5", // NativeAgentRegistry, 0.02 BOT floor
    // Redeployed with PRICE_UNIT = 1e18. The first engine here inherited a
    // hardcoded 1e6 ("one USDC") reference, so `(1e6 * 100) / bidAmount` truncated
    // to 0 for every realistic BOT bid and the 25% price weight was dead: the
    // auction ranked on reputation, speed and the fairness lottery only.
    bidEngine: "0x63724d7aABE3BFB845E34A6BF3F556785ac547F2",
    taskRegistry: "0x033f64d0cE625a0bbB11af05E906257eF4Cb03c5", // NativeTaskRegistry
    verifierBridge: "0xbf961E33a979D60De757F329f153e739cf0F798B",
    agentBadges: "0xaFD624a29D95B5819f029e148C116F6D27A37136",
    // Native-value twins, so subscriptions, the recurring market and staked
    // disputes work here rather than being switched off.
    subscriptionManager: "0x0697FC647353DA30e2e89Ab06208B7262723B6C9", // NativeSubscriptionManager
    recurringMarket: "0x3322Cc47548003fa4A37E538C14A818F37F50207", // NativeRecurringMarket
    disputeManager: "0x89C46703d5abA34C26fE2b35cf8B8C7bBE657dC6", // NativeDisputeManager
    // RevenueRouter collects an ERC-20 protocol fee and has no native twin yet.
    revenueRouter: null,
  },

  assets: [
    {
      symbol: "BOT",
      address: null, // native coin — value moves as msg.value
      decimals: 18,
      isEscrowAsset: true,
      isGasToken: true, // budgets and gas are the same coin here
      isNative: true,
    },
  ],

  wallet: {
    kind: "reown",
    canSignMessages: true, // EOA personal_sign; smart accounts via ERC-1271
    // PolarisAccountFactory, deployed against the canonical EntryPoint v0.7. Agent
    // accounts are CREATE2-derived from their owner key, and Polaris submits their
    // UserOperations itself through EntryPoint.handleOps because BOT Chain has no
    // public bundler.
    smartAccount: smartAccount("0x9a12b7ff87a59A9C93ad405C7C44Bff74994CcB6"),
  },

  // BOT testnet had no ERC-8004 at all — the canonical registry addresses have no
  // code (verified via eth_getCode), and the "IdentityRegistry*" contracts in the
  // explorer are ERC-3643/T-REX permissioned-token contracts, unrelated to
  // ERC-8004. These are the reference implementations deployed by Polaris
  // (contracts/scripts/deploy-erc8004.cjs): interface-compliant, at our own
  // addresses rather than the canonical vanity ones.
  erc8004: {
    identity: "0x6ea260520853dDbc9A938f23613BE9069a58eeaD",
    reputation: "0x0A5845E703BCD9F946707a75e1A9c64D9797200c",
    validation: "0x0e1EBCAf962f5957fDa20f110DD142C5bFdedcFe",
    provenance: "polaris-deployed",
  },

  // Matches NativeAgentRegistry's constructor arg on this deployment (verified
  // on-chain: MIN_STAKE() == 0.02 BOT).
  minStake: 0.02,

  // The deploy block — BOT blocks are ~0.67s (~128k/day), so scanning from 0 is
  // not an option.
  indexFromBlock: 20272428,
  logChunkBlocks: 9000,

  deployed: true,
  faucetUrl: "https://faucet.botchain.ai/basic",

  // Measured on this deployment at BOT's fixed 20 gwei: register 170,717 gas =
  // 0.0034 BOT, placeBid 197,464 = 0.0039, awardBid 149,001 = 0.0030. Posting a
  // task (escrow + registry) is the heaviest of them, so round up to 0.005.
  estTxFee: 0.005,

  // BOT Chain's own runtime — a separate service from Arc's, with no Circle
  // dependency: raw-key/ERC-4337 agent wallets and native-BOT settlement.
  apiBaseUrl: apiBase("BOTCHAIN_TESTNET", "https://polaris-bot-runtime-production.up.railway.app"),
  supportsX402: false,
};

export const botMainnetConfig: NetworkConfig = {
  id: "botchain-mainnet",
  label: "BOT Chain",
  shortLabel: "BOT Mainnet",
  chainId: BOT_MAINNET_CHAIN_ID,
  chain: botMainnet,
  rpcUrl: BOT_MAINNET_RPC_URL,
  explorerUrl: BOT_MAINNET_EXPLORER,
  explorerName: "BOTScan",
  testnet: false,
  accent: "bot",

  contracts: {
    usdc: null, // native BOT — no token contract
    usdcEscrow: null,
    agentRegistry: null,
    bidEngine: null,
    taskRegistry: null,
    verifierBridge: null,
    revenueRouter: null,
    subscriptionManager: null,
    agentBadges: null,
    disputeManager: null,
    recurringMarket: null,
  },

  assets: [
    {
      symbol: "BOT",
      address: null,
      decimals: 18,
      isEscrowAsset: true,
      isGasToken: true,
      isNative: true,
    },
  ],

  wallet: {
    kind: "reown",
    canSignMessages: true,
    smartAccount: smartAccount(null),
  },

  // The canonical ERC-8004 addresses DO exist on BOT mainnet, but they are
  // ERC-1967 proxies still delegating to a `MinimalUUPSMainnet` placeholder —
  // every registry call reverts (verified). The real implementations are
  // deployed but unwired, and the upgrade is signed by the standard's owner key,
  // which Polaris does not hold. So: null until Polaris deploys its own, or
  // until the canonical proxies are upgraded and this points at them.
  erc8004: null,

  // Intended floor, not yet deployed — pick it deliberately before deploying here.
  minStake: 0.02,

  indexFromBlock: 20018236,
  logChunkBlocks: 9000,

  // Real money: BOT is ~$9 and gas is a flat 20 gwei. Deployment is deliberately
  // deferred until a funded deployer exists.
  deployed: false,
  faucetUrl: null, // mainnet BOT is acquired on BDEX, not a faucet
  estTxFee: 0.005, // same gas, same fixed price as testnet

  // No mainnet runtime yet; the network is `deployed: false`, so nothing calls it.
  apiBaseUrl: apiBase("BOTCHAIN_MAINNET", ""),
  supportsX402: false,
};
