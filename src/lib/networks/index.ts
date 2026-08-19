import { arcTestnetConfig } from "./arc";
import { botTestnetConfig, botMainnetConfig } from "./botchain";
import type { NetworkConfig, NetworkId, PolarisAsset } from "./types";

export type { NetworkConfig, NetworkId, PolarisAsset, ContractKey } from "./types";
import { activeNetworkId } from "./active";
export { setActiveNetworkId, activeNetworkId } from "./active";
export { arcTestnet, botTestnet, botMainnet } from "./chains";

/**
 * The network registry — one Polaris, several chains.
 *
 * Every network-dependent thing in the app resolves through here: contract
 * addresses, RPC, explorer, payment asset, wallet adapter, indexer settings. The
 * default is always Arc, so any call site that hasn't been passed an explicit
 * network behaves exactly as it did before multi-chain support existed.
 */
export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  "arc-testnet": arcTestnetConfig,
  "botchain-testnet": botTestnetConfig,
  "botchain-mainnet": botMainnetConfig,
};

/** Arc stays the default everywhere — existing behaviour is the fallback. */
export const DEFAULT_NETWORK: NetworkId = "arc-testnet";

export const NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && value in NETWORKS;
}

/**
 * Config for a network id.
 *
 * An omitted or unrecognised id resolves to the ACTIVE network (what the user is
 * looking at), and only falls back to Arc before a network has been selected.
 * Resolving to Arc instead was the cause of Arcscan links and USDC labels showing
 * up on BOT Chain pages: every helper here is called without an explicit network
 * from dozens of places, and each of those was silently answering for Arc.
 */
export function getNetwork(id?: NetworkId | string | null): NetworkConfig {
  if (isNetworkId(id)) return NETWORKS[id];
  const active = activeNetworkId();
  return NETWORKS[isNetworkId(active) ? active : DEFAULT_NETWORK];
}

export function getNetworkByChainId(chainId: number): NetworkConfig | undefined {
  return NETWORK_IDS.map((id) => NETWORKS[id]).find((n) => n.chainId === chainId);
}

/**
 * Networks a user may actually select: the Polaris contract set must be deployed.
 * This is the fail-closed rule — a half-configured network is hidden rather than
 * shown and then silently served another chain's data.
 */
export function selectableNetworks(): NetworkConfig[] {
  return NETWORK_IDS.map((id) => NETWORKS[id]).filter((n) => n.deployed);
}

/** True when a network is configured well enough to transact on. */
export function isNetworkReady(id?: NetworkId | string | null): boolean {
  const n = getNetwork(id);
  return n.deployed && Boolean(n.contracts.taskRegistry && n.contracts.agentRegistry);
}

/** The asset task budgets and stakes are denominated in (USDC on Arc, USDT on
 *  BOT Chain). Every network has exactly one — it's fixed at escrow deploy. */
export function escrowAsset(id?: NetworkId | string | null): PolarisAsset {
  const n = getNetwork(id);
  const asset = n.assets.find((a) => a.isEscrowAsset);
  if (!asset) throw new Error(`Network ${n.id} has no escrow asset configured`);
  return asset;
}

/** Ticker for UI copy — replaces the hardcoded "USDC" strings. */
export function assetSymbol(id?: NetworkId | string | null): string {
  return escrowAsset(id).symbol;
}

/** Decimals of the escrow asset. Both supported chains use 6, but never assume. */
export function assetDecimals(id?: NetworkId | string | null): number {
  return escrowAsset(id).decimals;
}

/** The gas token's symbol — "USDC" on Arc (gas is dollar-denominated there),
 *  "BOT" on BOT Chain. Used wherever the UI talks about network fees. */
export function gasSymbol(id?: NetworkId | string | null): string {
  return getNetwork(id).chain.nativeCurrency.symbol;
}

/** Explorer link builders — never construct these by string assumption. */
export function explorerTxUrl(hash: string, id?: NetworkId | string | null): string {
  return `${getNetwork(id).explorerUrl}/tx/${hash}`;
}
export function explorerAddrUrl(addr: string, id?: NetworkId | string | null): string {
  return `${getNetwork(id).explorerUrl}/address/${addr}`;
}
