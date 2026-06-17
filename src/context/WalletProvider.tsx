import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAccount } from "wagmi";
import {
  circleEnabled,
  registerCircleWallet,
  loginCircleWallet,
  circleUsdcBalance,
  type CircleSession,
} from "../lib/circleWallet";
import {
  ucWalletEnabled,
  connectEmailWallet as connectEmailWalletLib,
  ucUsdcBalance,
  type UcSession,
} from "../lib/circleUserWallet";

/**
 * Wallet layer for Polaris. Circle Modular Wallets (passkey smart accounts) are
 * the primary wallet. The chosen username is persisted so the user can log back
 * in later with the same passkey.
 */
const LAST_USER_KEY = "polaris-circle-username";
const LAST_UC_KEY = "polaris-uc-email";

type Ctx = {
  address?: `0x${string}`;
  isConnected: boolean;
  circle: CircleSession | null;
  /** Circle user-controlled (PIN/email) session, when that wallet is connected. */
  uc: UcSession | null;
  /** Whichever Circle session is active (passkey or PIN), for routing writes. */
  signer: CircleSession | UcSession | null;
  circleEnabled: boolean;
  ucEnabled: boolean;
  connecting: boolean;
  /** USDC balance of the connected wallet (human units), refreshed periodically. */
  balance: number | null;
  /** Last username this browser registered/logged in with (for quick re-login). */
  lastUsername: string | null;
  /** Last email this browser used for an OTP login (for quick re-login). */
  lastUcEmail: string | null;
  connect: (username: string, mode: "register" | "login") => Promise<void>;
  connectEmailWallet: (email: string) => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => void;
};

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { address: injected } = useAccount();
  const [circle, setCircle] = useState<CircleSession | null>(null);
  const [uc, setUc] = useState<UcSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [lastUsername, setLastUsername] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_USER_KEY);
    } catch {
      return null;
    }
  });
  const [lastUcEmail, setLastUcEmail] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_UC_KEY);
    } catch {
      return null;
    }
  });

  const connect = useCallback(async (username: string, mode: "register" | "login") => {
    setConnecting(true);
    try {
      const session = mode === "register" ? await registerCircleWallet(username) : await loginCircleWallet(username);
      setCircle(session);
      setUc(null);
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

  const connectEmailWallet = useCallback(async (email: string) => {
    setConnecting(true);
    try {
      const session = await connectEmailWalletLib(email);
      setUc(session);
      setCircle(null);
      try {
        localStorage.setItem(LAST_UC_KEY, email);
      } catch {
        /* ignore */
      }
      setLastUcEmail(email);
    } finally {
      setConnecting(false);
    }
  }, []);

  const refreshBalance = useCallback(() => {
    if (circle) circleUsdcBalance(circle).then(setBalance).catch(() => setBalance(null));
    else if (uc) ucUsdcBalance(uc).then(setBalance).catch(() => setBalance(null));
  }, [circle, uc]);

  useEffect(() => {
    if (!circle && !uc) {
      setBalance(null);
      return;
    }
    refreshBalance();
    const id = setInterval(refreshBalance, 15000);
    return () => clearInterval(id);
  }, [circle, uc, refreshBalance]);

  const value: Ctx = {
    address: (circle?.address ?? uc?.address ?? injected) as `0x${string}` | undefined,
    isConnected: Boolean(circle || uc || injected),
    circle,
    uc,
    signer: circle ?? uc,
    circleEnabled: circleEnabled(),
    ucEnabled: ucWalletEnabled(),
    connecting,
    balance,
    lastUsername,
    lastUcEmail,
    connect,
    connectEmailWallet,
    disconnect: () => {
      setCircle(null);
      setUc(null);
    },
    refreshBalance,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): Ctx {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
