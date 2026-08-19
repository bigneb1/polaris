import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import type { AppKitNetwork } from "@reown/appkit-common";
import { createConfig, http, type Config } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet, botTestnet, botMainnet } from "../networks/chains";

/**
 * Reown AppKit — the wallet layer for BOT Chain.
 *
 * BOT Chain has no Circle support of any kind (no Modular Wallets, no MPC agent
 * wallets), so its human wallet is Reown: one modal covering hundreds of mobile
 * and desktop wallets over WalletConnect, plus network switching. Arc keeps Circle
 * Modular Wallets as its primary wallet and is unaffected — it simply also
 * appears in AppKit's network list, which is what lets the modal switch chains.
 *
 * AppKit owns the wagmi config when it's configured (the adapter and wagmi must
 * share connection state), so `resolvedWagmiConfig` below is what the app hands
 * to WagmiProvider.
 *
 * Our viem chain definitions are passed straight through: Reown's `AppKitNetwork`
 * is `BaseNetwork | CaipNetwork` and `BaseNetwork` IS a viem `Chain`, so there is
 * no second copy of the chain parameters to drift out of sync.
 */
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Reown Dashboard project id. The older `VITE_WALLETCONNECT_PROJECT_ID` name is
 *  accepted too — Reown is what WalletConnect Cloud became, and the id format is
 *  unchanged, so an existing key keeps working. */
export const REOWN_PROJECT_ID = ENV.VITE_REOWN_PROJECT_ID || ENV.VITE_WALLETCONNECT_PROJECT_ID || "";

export function reownEnabled(): boolean {
  return Boolean(REOWN_PROJECT_ID);
}

const networks = [arcTestnet, botTestnet, botMainnet] as [AppKitNetwork, ...AppKitNetwork[]];

/**
 * Polaris has a single dark palette, so the wallet modal is pinned to dark rather
 * than sniffing a theme attribute. It used to read `data-theme`, which the app no
 * longer sets, and so opened a light modal on top of a dark app.
 */
function currentThemeMode(): "dark" | "light" {
  return "dark";
}

let adapter: WagmiAdapter | null = null;
let modal: ReturnType<typeof createAppKit> | null = null;

if (reownEnabled()) {
  adapter = new WagmiAdapter({ networks, projectId: REOWN_PROJECT_ID, ssr: false });
  modal = createAppKit({
    adapters: [adapter],
    networks,
    projectId: REOWN_PROJECT_ID,
    defaultNetwork: botTestnet,
    metadata: {
      name: "Polaris",
      description: "Autonomous AI-agent task economy",
      url: typeof window !== "undefined" ? window.location.origin : "https://polarisswarm.xyz",
      icons: [
        typeof window !== "undefined"
          ? `${window.location.origin}/polaris-mark.svg`
          : "https://polarisswarm.xyz/polaris-mark.svg",
      ],
    },
    themeMode: currentThemeMode(),
    // Wallet connections only — Polaris has its own account model, and email/
    // social login would add a second identity system users don't need here.
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  });
}

/**
 * The wagmi config the app runs on. AppKit's adapter builds one that includes the
 * WalletConnect, injected and Coinbase connectors; when no Reown project id is
 * configured we fall back to a minimal local config so the app (and Arc's Circle
 * wallet, which doesn't depend on wagmi for signing) still works.
 */
export const resolvedWagmiConfig: Config =
  adapter?.wagmiConfig ??
  createConfig({
    chains: [arcTestnet, botTestnet, botMainnet],
    connectors: [injected()],
    transports: {
      [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
      [botTestnet.id]: http(botTestnet.rpcUrls.default.http[0]),
      [botMainnet.id]: http(botMainnet.rpcUrls.default.http[0]),
    },
    ssr: false,
  });

/** Open the Reown wallet modal. No-op (and reported) when unconfigured. */
export async function openReownModal(): Promise<void> {
  if (!modal) {
    throw new Error(
      "Reown isn't configured, set VITE_REOWN_PROJECT_ID (from dashboard.reown.com) to connect a wallet on BOT Chain.",
    );
  }
  await modal.open();
}

/** Open the modal on its network-switching view. */
export async function openReownNetworks(): Promise<void> {
  if (!modal) return;
  await modal.open({ view: "Networks" });
}

/** Ask AppKit to switch the connected wallet to a chain id we support. */
export function reownSwitchNetwork(chainId: number): void {
  if (!modal) return;
  const target = networks.find((n) => Number(n.id) === chainId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (target) modal.switchNetwork(target as any);
}

export function reownDisconnect(): void {
  modal?.disconnect().catch(() => {});
}

/** Keep the modal's palette in step with Polaris's light/dark toggle. */
export function reownSyncTheme(): void {
  modal?.setThemeMode(currentThemeMode());
}
