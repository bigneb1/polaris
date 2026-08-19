/**
 * The active network id, as a leaf module with NO imports.
 *
 * This exists so `networks/index.ts` can resolve an omitted network argument to
 * the network the user is actually looking at, without importing
 * `lib/activeNetwork.ts` (which imports `networks/index.ts` and would create a
 * cycle).
 *
 * Why it matters: `getNetwork(undefined)` used to fall back to Arc, so every
 * helper called without an explicit network — `explorerAddr(addr)`,
 * `assetSymbol()`, `escrowAsset()`, `contractsFor()` — quietly answered for Arc
 * while the user was on BOT Chain. That produced Arcscan links and "USDC" labels
 * on BOT Chain pages. Defaulting to the active network makes the omitted case
 * correct instead of merely convenient.
 */
let activeId: string | null = null;

export function setActiveNetworkId(id: string): void {
  activeId = id;
}

export function activeNetworkId(): string | null {
  return activeId;
}
