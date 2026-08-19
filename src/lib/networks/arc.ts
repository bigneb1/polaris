import { arcTestnet, ARC_RPC_URL, ARC_EXPLORER, ARC_CHAIN_ID } from "./chains";
import { apiBase } from "./apiBase";
import type { NetworkConfig } from "./types";

/**
 * Arc Testnet — the original, live Polaris deployment.
 *
 * These are the V4 addresses that were previously hardcoded in
 * src/lib/contracts.ts, moved here verbatim. They stay in SOURCE rather than env
 * on purpose: a stale `VITE_CONTRACT_*` override on a deploy host once pointed
 * the app at dead contracts, so created tasks/agents "vanished". The frontend is
 * rebuilt on every contract change, so this file is the source of truth.
 *
 * Nothing about Arc's behaviour changes with multi-chain support.
 */
export const arcTestnetConfig: NetworkConfig = {
  id: "arc-testnet",
  label: "Arc Testnet",
  shortLabel: "Arc",
  chainId: ARC_CHAIN_ID,
  chain: arcTestnet,
  rpcUrl: ARC_RPC_URL,
  explorerUrl: ARC_EXPLORER,
  explorerName: "Arcscan",
  testnet: true,
  accent: "arc",

  contracts: {
    usdc: "0x3600000000000000000000000000000000000000",
    usdcEscrow: "0xE9955f2A7fEcFC47844a5cDbbF39f424e2917c74",
    agentRegistry: "0xEb27dBC89529Bab0365a635F29Ffc720Eb87C470",
    bidEngine: "0x9Cd236e0Dd59496C9540ef657125073252d03397",
    taskRegistry: "0xe3ad52025F740599A5b02ffD394514fBD3E80F9C",
    verifierBridge: "0xA8C2Cd1D3dd31637e5b9138D856508444E826C3A",
    revenueRouter: "0xe26f6beE50A181211291E903D9EA792a02C4b296",
    // Phase A — recurring tasks & subscriptions.
    subscriptionManager: "0x3DbA6eD862d4247A30D6dF76d438bEeC72cfb61a",
    // Phase D — on-chain agent verification tiers.
    agentBadges: "0x6c5f75992390079A0A0aaD51059D7bA05Dc1b842",
    // Phase C — staked dispute resolution.
    disputeManager: "0xD965F54429a83F80D46462342B24f1814FeBBf05",
    // Recurring market — auctioned recurring tasks with per-delivery release.
    recurringMarket: "0xD0DBF9323f7275305868f4f83AaCF1160d2B20Fd",
  },

  assets: [
    {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
      isEscrowAsset: true,
      // On Arc, USDC IS the native gas token — fees are dollar-denominated. But
      // budgets/stakes still move as an ERC-20 at the system address, so this is
      // not the `isNative` (msg.value) path.
      isGasToken: true,
      isNative: false,
    },
  ],

  wallet: {
    kind: "circle",
    canSignMessages: true, // passkey smart account signs via ERC-1271
    smartAccount: null, // Circle Modular Wallets already provide the smart account
  },

  // Arc testnet does carry the canonical ERC-8004 testnet registries (verified
  // live: IdentityRegistry.name() === "AgentIdentity"), but Polaris does not use
  // them on Arc today. Left null so nothing about the live Arc deployment
  // changes; wiring them up would be a separate, additive decision.
  erc8004: null,

  // AgentRegistry.MIN_STAKE = 100_000_000 == 100 USDC at 6 decimals.
  minStake: 100,

  indexFromBlock: 47764000,
  logChunkBlocks: 9000,

  deployed: true,
  faucetUrl: "https://faucet.circle.com",

  // Arc's own runtime: Circle agent wallets, USDC escrow, x402.
  apiBaseUrl: apiBase("ARC", "https://polaris-agent-runtime-production.up.railway.app"),
  supportsX402: true,
  // Arc's gas token IS USDC, so a transaction costs about a cent.
  estTxFee: 0.01,
};
