import { DEFAULT_NETWORK, getNetwork, isNetworkId, setActiveNetworkId, type NetworkConfig, type NetworkId } from "./networks";

/**
 * A module-level mirror of the active network, kept in sync by NetworkProvider.
 *
 * Why this exists: `lib/api.ts` and `lib/tx.ts` are plain modules called from
 * dozens of places, and threading a network argument through every one of them
 * would mean a single missed call site silently transacts on Arc while the user
 * is looking at BOT Chain. That's the exact failure mode this integration must
 * not have, so the default resolves from here instead of being hardcoded to Arc.
 *
 * React state in NetworkProvider stays the source of truth for rendering; this is
 * only the default for non-React callers. Anything that can pass an explicit
 * network still should.
 */
let active: NetworkId = DEFAULT_NETWORK;

export function setActiveNetwork(id: NetworkId): void {
  if (!isNetworkId(id)) return;
  active = id;
  // Also tell the networks registry, so `getNetwork()` with no argument resolves
  // here rather than to Arc (see networks/active.ts).
  setActiveNetworkId(id);
}

export function getActiveNetwork(): NetworkId {
  return active;
}

export function activeNetworkConfig(): NetworkConfig {
  return getNetwork(active);
}

/** Resolve an optional network argument to a concrete id. */
export function resolveNetwork(network?: NetworkId | string | null): NetworkId {
  return isNetworkId(network) ? network : active;
}
