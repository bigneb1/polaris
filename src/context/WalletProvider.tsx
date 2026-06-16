import { createContext, useContext, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import {
  circleEnabled,
  registerCircleWallet,
  loginCircleWallet,
  type CircleSession,
} from "../lib/circleWallet";

/**
 * Wallet layer for Polaris. Circle Modular Wallets (passkey smart accounts) are
 * the PRIMARY wallet — WalletConnect/RainbowKit has been removed. An injected
 * browser wallet (if present) is kept only as a silent read/sign fallback so the
 * app still functions before a Circle client key is configured.
 */
type Ctx = {
  /** active address — Circle smart account if connected, else injected fallback */
  address?: `0x${string}`;
  isConnected: boolean;
  /** the Circle passkey session, when connected */
  circle: CircleSession | null;
  circleEnabled: boolean;
  connecting: boolean;
  connect: (username: string, mode: "register" | "login") => Promise<void>;
  disconnect: () => void;
};

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { address: injected } = useAccount();
  const [circle, setCircle] = useState<CircleSession | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = async (username: string, mode: "register" | "login") => {
    setConnecting(true);
    try {
      const session = mode === "register" ? await registerCircleWallet(username) : await loginCircleWallet(username);
      setCircle(session);
    } finally {
      setConnecting(false);
    }
  };

  const value: Ctx = {
    address: (circle?.address ?? injected) as `0x${string}` | undefined,
    isConnected: Boolean(circle || injected),
    circle,
    circleEnabled: circleEnabled(),
    connecting,
    connect,
    disconnect: () => setCircle(null),
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
