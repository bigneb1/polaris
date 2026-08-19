import { useNetwork } from "../context/NetworkProvider";

/**
 * The active network's payment asset, for UI copy.
 *
 * Polaris denominates task budgets and agent stakes in whatever asset its escrow
 * was deployed against — USDC on Arc, the chain's own native BOT on BOT Chain — so
 * no label should ever hardcode a ticker. `gas` is separate: on Arc gas IS USDC
 * (fees are dollar-denominated), on BOT Chain both are native BOT.
 */
export function useAsset() {
  const { network } = useNetwork();
  const escrow = network.assets.find((a) => a.isEscrowAsset);
  return {
    /** Escrow-asset ticker: "USDC" on Arc, "BOT" on BOT Chain. */
    symbol: escrow?.symbol ?? "USDC",
    decimals: escrow?.decimals ?? 6,
    /** Gas token ticker for this network. */
    gasSymbol: network.chain.nativeCurrency.symbol,
    /** True when gas is paid in the same asset as budgets (Arc's USDC, BOT's BOT). */
    gasIsAsset: Boolean(escrow?.isGasToken),
    /** True when the asset IS the chain's native coin (BOT Chain) — no approve
     *  step, and fees are denominated in the coin rather than in dollars. */
    nativeAsset: Boolean(escrow?.isNative),
    /** True only where fees are genuinely dollar-denominated: a stablecoin that is
     *  also the gas token, which is Arc's distinguishing property. Guards copy that
     *  would otherwise claim "~$0.01 fees" on a network priced in BOT. */
    feesInDollars: Boolean(escrow?.isGasToken) && !escrow?.isNative,
    network,
  };
}
