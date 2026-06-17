import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

/**
 * Arc Testnet - Circle's stablecoin-native L1.
 *
 * Verified params (2026-06-15) against docs.arc.io + Alchemy/QuickNode/thirdweb
 * chainlists. NOTE the original build prompt had three wrong values, corrected
 * here:
 *   - chain id 5042002 → hex 0x4CEF52  (prompt said 0x4CFC52, wrong)
 *   - RPC  https://rpc.testnet.arc.network  (prompt said rpc.arc.network)
 *   - explorer https://testnet.arcscan.app  (prompt said explorer.arc.network)
 *
 * USDC is the NATIVE gas token at the system address below. The ERC-20 interface
 * uses 6 decimals (native gas precision is 18 - always read decimals onchain
 * rather than assuming).
 */
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const ARC_RPC_URL = ENV.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network";
export const ARC_EXPLORER = ENV.VITE_ARC_EXPLORER || "https://testnet.arcscan.app";
export const ARC_CHAIN_ID = Number(ENV.VITE_ARC_CHAIN_ID || "5042002");
export const USDC_ADDRESS = (ENV.VITE_USDC_ADDRESS ||
  "0x3600000000000000000000000000000000000000") as `0x${string}`;
export const USDC_DECIMALS = 6;

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
  // include it so viem's batched reads work. If Arc has not deployed it, the
  // indexing layer (lib/onchain.ts) falls back to sequential reads.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/** Build an explorer link for a tx or address. */
export function explorerTx(hash: string) {
  return `${ARC_EXPLORER}/tx/${hash}`;
}
export function explorerAddr(addr: string) {
  return `${ARC_EXPLORER}/address/${addr}`;
}

// WalletConnect/RainbowKit removed - Circle Modular Wallets is the primary wallet
// (see src/context/WalletProvider.tsx). wagmi is kept only for chain reads (the
// event indexer) and an optional injected-wallet fallback for signing.
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(ARC_RPC_URL),
  },
  ssr: false,
});
