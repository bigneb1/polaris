import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAccount } from "wagmi";
import {
  circleEnabled,
  registerCircleWallet,
  loginCircleWallet,
  restoreCircleWallet,
  clearCachedCredential,
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
const UC_SESSION_KEY = "polaris-uc-session";

/** The email (UC) session is plain data, so it survives reloads in localStorage. */
function loadUcSession(): UcSession | null {
  try {
    const raw = localStorage.getItem(UC_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as UcSession;
    return s && s.kind === "uc" && s.address && s.walletId ? s : null;
  } catch {
    return null;
  }
}

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
  // Rehydrate the email session so users stay logged in across reloads until
  // they disconnect or clear their browser. (Passkey sessions hold non-
  // serializable signer objects, so they re-auth on demand instead.)
  const [uc, setUc] = useState<UcSession | null>(() => loadUcSession());
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
        localStorage.setItem(UC_SESSION_KEY, JSON.stringify(session));
      } catch {
        /* ignore */
      }
      setLastUcEmail(email);
    } finally {
      setConnecting(false);
    }
  }, []);

  // Restore a passkey session from the cached credential on load (no prompt), so
  // passkey logins persist across refresh like the email session does. Skipped
  // if an email session is already active.
  useEffect(() => {
    if (uc) return;
    let alive = true;
    restoreCircleWallet()
      .then((s) => {
        if (alive && s) setCircle((cur) => cur ?? s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      clearCachedCredential();
      try {
        localStorage.removeItem(UC_SESSION_KEY);
      } catch {
        /* ignore */
      }
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
