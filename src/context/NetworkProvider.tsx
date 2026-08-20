import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_NETWORK,
  getNetwork,
  isNetworkId,
  selectableNetworks,
  NETWORK_IDS,
  NETWORKS,
  type NetworkConfig,
  type NetworkId,
} from "../lib/networks";
import { setActiveNetwork } from "../lib/activeNetwork";

/**
 * Active-network context — the single place the app asks "which chain are we on?".
 *
 * Persisted so a reload keeps the user where they were, and defaulted to Arc so
 * A stored id that is no longer selectable (e.g. a network whose contracts were never
 * deployed) falls back to DEFAULT_NETWORK rather than leaving the app pointed at a chain it
 * cannot serve. A returning user keeps whatever they last chose; the default only decides
 * where a first-time visitor lands.
 */
const STORAGE_KEY = "polaris-network";

function loadStored(): NetworkId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isNetworkId(raw) && NETWORKS[raw].deployed) return raw;
  } catch {
    /* private mode / storage disabled */
  }
  return DEFAULT_NETWORK;
}

type Ctx = {
  /** Active network's id. */
  networkId: NetworkId;
  /** Active network's full config: addresses, assets, explorer, wallet kind. */
  network: NetworkConfig;
  /** Networks the user can pick (deployed only). */
  available: NetworkConfig[];
  /** Every configured network, including ones not yet deployed. */
  all: NetworkConfig[];
  setNetwork: (id: NetworkId) => void;
  /** True when more than one network is live — lets the UI hide the switcher
   *  entirely rather than showing a pointless single-item menu. */
  multiNetwork: boolean;
};

const NetworkCtx = createContext<Ctx | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [networkId, setNetworkId] = useState<NetworkId>(() => {
    const stored = loadStored();
    // Mirror into the module-level default synchronously, before any child
    // renders or any api/tx module is called.
    setActiveNetwork(stored);
    return stored;
  });

  const setNetwork = useCallback((id: NetworkId) => {
    if (!isNetworkId(id) || !NETWORKS[id].deployed) return;
    setActiveNetwork(id);
    setNetworkId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Ctx>(() => {
    const available = selectableNetworks();
    return {
      networkId,
      network: getNetwork(networkId),
      available,
      all: NETWORK_IDS.map((id) => NETWORKS[id]),
      setNetwork,
      multiNetwork: available.length > 1,
    };
  }, [networkId, setNetwork]);

  return <NetworkCtx.Provider value={value}>{children}</NetworkCtx.Provider>;
}

export function useNetwork(): Ctx {
  const ctx = useContext(NetworkCtx);
  if (!ctx) throw new Error("useNetwork must be used within NetworkProvider");
  return ctx;
}
