import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAccount } from "wagmi";
import {
  circleEnabled,
  registerCircleWallet,
  loginCircleWallet,
  circleUsdcBalance,
  type CircleSession,
} from "../lib/circleWallet";

/**
 * Wallet layer for Polaris. Circle Modular Wallets (passkey smart accounts) are
 * the primary wallet. The chosen username is persisted so the user can log back
 * in later with the same passkey.
 */
const LAST_USER_KEY = "polaris-circle-username";

type Ctx = {
  address?: `0x${string}`;
  isConnected: boolean;
  circle: CircleSession | null;
  circleEnabled: boolean;
  connecting: boolean;
  /** USDC balance of the connected wallet (human units), refreshed periodically. */
  balance: number | null;
  /** Last username this browser registered/logged in with (for quick re-login). */
  lastUsername: string | null;
  connect: (username: string, mode: "register" | "login") => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => void;
};

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { address: injected } = useAccount();
  const [circle, setCircle] = useState<CircleSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [lastUsername, setLastUsername] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_USER_KEY);
    } catch {
      return null;
    }
  });

  const connect = useCallback(async (username: string, mode: "register" | "login") => {
    setConnecting(true);
    try {
      const session = mode === "register" ? await registerCircleWallet(username) : await loginCircleWallet(username);
      setCircle(session);
      try {
        localStorage.setItem(LAST_USER_KEY, username);
      } catch {
        /* ignore */
      }
      setLastUsername(username);
    } finally {
      setConnecting(false);
    }
  }, []);

  const refreshBalance = useCallback(() => {
    if (circle) circleUsdcBalance(circle).then(setBalance).catch(() => setBalance(null));
  }, [circle]);

  useEffect(() => {
    if (!circle) {
      setBalance(null);
      return;
    }
    refreshBalance();
    const id = setInterval(refreshBalance, 15000);
    return () => clearInterval(id);
  }, [circle, refreshBalance]);

  const value: Ctx = {
    address: (circle?.address ?? injected) as `0x${string}` | undefined,
    isConnected: Boolean(circle || injected),
    circle,
    circleEnabled: circleEnabled(),
    connecting,
    balance,
    lastUsername,
    connect,
    disconnect: () => setCircle(null),
    refreshBalance,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
