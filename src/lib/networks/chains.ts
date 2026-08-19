import { defineChain } from "viem";

/**
 * Viem chain definitions for every network Polaris supports.
 *
 * Kept in its own module (rather than in lib/chain.ts) so the network configs can
 * import chains without a cycle: chains.ts → arc.ts/botchain.ts → index.ts, and
 * lib/chain.ts re-exports `arcTestnet` from here so every existing
 * `import { arcTestnet } from "./chain"` call site keeps working unchanged.
 */
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/* ── Arc Testnet (chain 5042002) — Circle's stablecoin-native L1 ──────────────
 * USDC is the NATIVE gas token at the system address. The ERC-20 interface uses
 * 6 decimals (native gas precision is 18). Unchanged from the original config.
 */
export const ARC_RPC_URL = ENV.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network";
export const ARC_EXPLORER = ENV.VITE_ARC_EXPLORER || "https://testnet.arcscan.app";
export const ARC_CHAIN_ID = Number(ENV.VITE_ARC_CHAIN_ID || "5042002");

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
    public: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: ARC_EXPLORER },
  },
  testnet: true,
  // Multicall3 lives at the canonical cross-chain address on most EVM L1s;
  // include it so viem's batched reads work.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/* ── BOT Chain (testnet 968 "Bohr" / mainnet 677) ────────────────────────────
 * EVM-compatible BNB-family L1 for DePIN + AI (Parlia consensus, EIP-4844
 * blobs, ~0.67s blocks, flat 20 gwei gas). Gas is paid in native BOT (18 dec) —
 * NOT in a stablecoin, unlike Arc. Both chain IDs were verified live against
 * `eth_chainId` (968 → 0x3c8, 677 → 0x2a5) rather than taken from docs.
 * Explorers are Blockscout on both networks.
 */
export const BOT_TESTNET_RPC_URL = ENV.VITE_BOT_TESTNET_RPC || "https://rpc.bohr.life";
export const BOT_TESTNET_EXPLORER = ENV.VITE_BOT_TESTNET_EXPLORER || "https://scan.bohr.life";
export const BOT_TESTNET_CHAIN_ID = Number(ENV.VITE_BOT_TESTNET_CHAIN_ID || "968");

export const BOT_MAINNET_RPC_URL = ENV.VITE_BOT_MAINNET_RPC || "https://rpc.botchain.ai";
export const BOT_MAINNET_EXPLORER = ENV.VITE_BOT_MAINNET_EXPLORER || "https://scan.botchain.ai";
export const BOT_MAINNET_CHAIN_ID = Number(ENV.VITE_BOT_MAINNET_CHAIN_ID || "677");

export const botTestnet = defineChain({
  id: BOT_TESTNET_CHAIN_ID,
  name: "BOT Chain Testnet",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: [BOT_TESTNET_RPC_URL] },
    public: { http: [BOT_TESTNET_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "BOTScan", url: BOT_TESTNET_EXPLORER },
  },
  testnet: true,
  // BDEX's Multicall3 deployment (the canonical 0xcA11… address has no code on
  // BOT testnet — verified with eth_getCode — so point viem at the real one).
  contracts: {
    multicall3: { address: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265" },
  },
});

export const botMainnet = defineChain({
  id: BOT_MAINNET_CHAIN_ID,
  name: "BOT Chain",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: [BOT_MAINNET_RPC_URL] },
    public: { http: [BOT_MAINNET_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "BOTScan", url: BOT_MAINNET_EXPLORER },
  },
  testnet: false,
  contracts: {
    multicall3: { address: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265" },
  },
});
