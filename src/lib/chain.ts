import { getNetwork, explorerTxUrl, explorerAddrUrl, type NetworkId } from "./networks";
import { resolvedWagmiConfig } from "./wallets/reown";

/**
 * Chain wiring for Polaris.
 *
 * Chain definitions themselves now live in lib/networks/chains.ts (so the network
 * configs can import them without a cycle); this module keeps the original
 * exports so every existing call site — `import { arcTestnet, USDC_DECIMALS,
 * explorerTx } from "../lib/chain"` — keeps working unchanged, and adds the
 * multi-chain wagmi config.
 *
 * Arc Testnet params, verified 2026-06-15 against docs.arc.io + chainlists (the
 * original build prompt had three wrong values, corrected then and unchanged
 * since): chain id 5042002, RPC https://rpc.testnet.arc.network, explorer
 * https://testnet.arcscan.app. USDC is the NATIVE gas token there; its ERC-20
 * interface uses 6 decimals.
 */
export {
  arcTestnet,
  botTestnet,
  botMainnet,
  ARC_RPC_URL,
  ARC_EXPLORER,
  ARC_CHAIN_ID,
} from "./networks/chains";

const arc = getNetwork("arc-testnet");

/** Arc's USDC. Kept for existing call sites; network-aware code should use
 *  `escrowAsset(networkId)` from lib/networks instead. */
export const USDC_ADDRESS = arc.contracts.usdc as `0x${string}`;
export const USDC_DECIMALS = 6;

/** Build an explorer link for a tx or address on `network` (default Arc). */
export function explorerTx(hash: string, network?: NetworkId) {
  return explorerTxUrl(hash, network);
}
export function explorerAddr(addr: string, network?: NetworkId) {
  return explorerAddrUrl(addr, network);
}

/**
 * The app's wagmi config, covering every supported network.
 *
 * Built by Reown AppKit's wagmi adapter (see lib/wallets/reown.ts) so the modal
 * and wagmi share one connection state — Reown is the human wallet on BOT Chain,
 * where Circle has no support. Circle Modular Wallets remain Arc's primary wallet
 * and don't route through wagmi for signing, so Arc's behaviour is unchanged.
 */
export const wagmiConfig = resolvedWagmiConfig;
