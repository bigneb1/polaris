import type { Address, Chain } from "viem";

/** Every network Polaris can operate on. Ids are stable — they key config,
 *  localStorage, react-query cache and the backend's `?network=` param. */
export type NetworkId = "arc-testnet" | "botchain-testnet" | "botchain-mainnet";

/** The Polaris contract set. Keys match src/lib/contracts.ts exactly. */
export type ContractKey =
  | "usdc"
  | "usdcEscrow"
  | "agentRegistry"
  | "bidEngine"
  | "taskRegistry"
  | "verifierBridge"
  | "revenueRouter"
  | "subscriptionManager"
  | "agentBadges"
  | "disputeManager"
  | "recurringMarket";

/** A payable asset on a network. `isEscrowAsset` marks the one task budgets and
 *  agent stakes are denominated in — the token the escrow contract was deployed
 *  against, so it cannot be switched without redeploying. */
export type PolarisAsset = {
  symbol: string;
  /** ERC-20 address, or NULL when the asset is the chain's own native coin —
   *  there is no token contract to approve or call `balanceOf` on. Nullable on
   *  purpose: it makes the compiler point at every ERC-20 assumption. */
  address: Address | null;
  decimals: number;
  isEscrowAsset: boolean;
  /** True when this is also the chain's gas token (Arc's USDC is; BOT's native
   *  BOT is, being the same coin). */
  isGasToken: boolean;
  /** True when value moves as `msg.value` rather than through an ERC-20:
   *  no approve step, and balances come from getBalance. */
  isNative: boolean;
};

/**
 * How humans hold funds on a network.
 *  - "circle": Circle Modular (passkey) + Circle user-controlled (PIN/email).
 *    Arc only — Circle has no BOT Chain support.
 *  - "reown": Reown AppKit — one modal over WalletConnect covering hundreds of
 *    mobile and desktop wallets. BOT Chain's wallet.
 */
export type WalletKind = "circle" | "reown";

export type SmartAccountConfig = {
  /** ERC-4337 EntryPoint. v0.7 canonical address, verified byte-identical on BOT. */
  entryPoint: Address;
  entryPointVersion: "0.7";
  /** Our account factory. Null until deployed — smart-account features stay off. */
  accountFactory: Address | null;
  /** No public bundler exists on BOT Chain, so Polaris submits UserOperations
   *  itself via EntryPoint.handleOps from a relayer EOA (self-bundling). */
  bundlerUrl: string | null;
};

/** ERC-8004 registries. Null when the network has none Polaris can use. */
export type Erc8004Config = {
  identity: Address;
  reputation: Address | null;
  validation: Address | null;
  /** Where these came from — surfaced in the UI so "canonical" is never implied
   *  for a registry Polaris deployed itself. */
  provenance: "canonical" | "polaris-deployed";
};

export type NetworkConfig = {
  id: NetworkId;
  /** Full name for menus and empty states: "BOT Chain Testnet". */
  label: string;
  /** Compact name for chips and the switcher: "BOT Testnet". */
  shortLabel: string;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  explorerUrl: string;
  explorerName: string;
  testnet: boolean;
  /** Accent token used by network-aware UI. */
  accent: "arc" | "bot";
  /** The chain's own mark, served from /public/chains. Shown wherever a network is named. */
  logo: string;

  contracts: Record<ContractKey, Address | null>;
  assets: PolarisAsset[];

  wallet: {
    kind: WalletKind;
    /** False for wallets with no off-chain message signing (Circle PIN wallet);
     *  gates the signed-deliverable and view-token flows. */
    canSignMessages: boolean;
    smartAccount: SmartAccountConfig | null;
  };

  erc8004: Erc8004Config | null;

  /** Agent collateral floor, in whole units of the escrow asset. Differs per
   *  network: the ERC-20 registry hardcodes 100, while a native network sets it at
   *  deploy time (BOT is 18 decimals, where that constant would be dust). */
  minStake: number;

  /** Indexing. Arc caps eth_getLogs at 10,000 blocks; keep chunks <= 9000.
   *  BOT's ~0.67s blocks mean ~128k blocks/day, so `indexFromBlock` must be the
   *  deploy block or the first scan is enormous. */
  indexFromBlock: number;
  logChunkBlocks: number;

  /** False until the Polaris contract set is deployed here. A network that is
   *  not deployed is not selectable — Polaris fails closed rather than silently
   *  falling back to another chain's contracts. */
  deployed: boolean;
  /** Where to get gas//test funds, shown in the UI when a balance is empty. */
  faucetUrl: string | null;

  /**
   * The verifier/runtime backend that serves THIS network.
   *
   * Each chain has its own runtime service, because the two are not
   * interchangeable: Arc's agents hold Circle MPC wallets and settle in USDC,
   * BOT Chain's hold raw-key/ERC-4337 accounts and settle in native BOT. Each
   * service indexes only its own chain and holds only its own signer, so asking
   * the wrong one is an error, not a slower answer — which is why this is per
   * network rather than one shared base URL with a `?network=` hint.
   *
   * Empty string means "same origin", for a dev server proxying /api.
   */
  apiBaseUrl: string;
  /** x402 nanopayments need a Circle Gateway facilitator, which only exists on
   *  Circle-supported chains. Arc: true. BOT: false (no Circle presence). */
  supportsX402: boolean;

  /**
   * Rough cost of one Polaris transaction, in units of `escrowAsset`, for fee
   * previews. Deliberately per network and not a shared "~$0.01": Arc prices gas
   * in USDC (so the figure is dollars), while BOT Chain prices it in BOT at a
   * fixed 20 gwei (so the figure is coins, and calling it "$" would be wrong
   * twice over).
   */
  estTxFee: number;
};
