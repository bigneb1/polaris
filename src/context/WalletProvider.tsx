import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  circleEnabled,
  registerCircleWallet,
  loginCircleWallet,
  restoreCircleWallet,
  clearCachedCredential,
  circleUsdcBalance,
  circleSignMessage,
  type CircleSession,
} from "../lib/circleWallet";
import {
  ucWalletEnabled,
  connectEmailWallet as connectEmailWalletLib,
  ucUsdcBalance,
  type UcSession,
} from "../lib/circleUserWallet";
import { useNetwork } from "./NetworkProvider";
import { openReownModal, reownDisconnect, reownEnabled, reownSwitchNetwork } from "../lib/wallets/reown";
import { usdcBalance } from "../lib/tx";
import type { WalletKind } from "../lib/networks/types";

/**
 * Wallet layer for Polaris.
 *
 * Which wallet a network uses is part of that network's config:
 *  - Arc (`kind: "circle"`) — Circle Modular Wallets (passkey smart accounts) are
 *    the primary wallet, with the Circle user-controlled (PIN/email) wallet as the
 *    second option. Unchanged from before multi-chain support.
 *  - BOT Chain (`kind: "reown"`) — Circle has no BOT Chain support at all, so the
 *    wallet is Reown AppKit: one modal covering hundreds of mobile and desktop
 *    wallets over WalletConnect, wired into wagmi by Reown's adapter.
 *
 * A Circle session is never treated as the active wallet on a network Circle
 * can't serve: the session object stays in memory (so switching back to Arc
 * doesn't force a re-login) but `address`/`signer` ignore it. That's what keeps a
 * BOT Chain action from ever being signed by an Arc wallet.
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
  /** Whichever Circle session is active (passkey or PIN), for routing writes.
   *  Null on networks that use Reown — tx.ts then takes the wagmi path and pins
   *  the transaction to the active network's chain id. */
  signer: CircleSession | UcSession | null;
  circleEnabled: boolean;
  ucEnabled: boolean;
  connecting: boolean;
  /** Which wallet family the active network uses. */
  walletKind: WalletKind;
  /**
   * The wallet the user actually connected, as it names itself: "MetaMask", "Rainbow",
   * "Coinbase Wallet". Null when we have no name to show.
   *
   * The UI used to print "Reown" here, which is the connection library rather than anyone's
   * wallet: a brand the user never chose and cannot act on. Naming the real connector is
   * what every other dapp does, and showing nothing is better than showing ours.
   */
  connectorName: string | null;
  /** Escrow-asset balance of the connected wallet on the ACTIVE network (human
   *  units), refreshed periodically. Never an aggregate across chains. */
  balance: number | null;
  /** Symbol that `balance` is denominated in: "USDC" on Arc, "BOT" on BOT Chain. */
  balanceSymbol: string;
  /** Last username this browser registered/logged in with (for quick re-login). */
  lastUsername: string | null;
  /** Last email this browser used for an OTP login (for quick re-login). */
  lastUcEmail: string | null;
  connect: (username: string, mode: "register" | "login") => Promise<void>;
  connectEmailWallet: (email: string) => Promise<void>;
  /** Open the Reown wallet modal — the connect path on BOT Chain. */
  connectReown: () => Promise<void>;
  /** False when no Reown project id is configured, so the UI can say so instead
   *  of opening a modal that can't work. */
  reownEnabled: boolean;
  disconnect: () => void;
  refreshBalance: () => void;
  /**
   * Sign an off-chain message (EIP-191) with the connected wallet — used to
   * prove wallet ownership to the backend (e.g. viewing a private deliverable)
   * without an on-chain tx. Works for a Reown-connected wallet and the Circle
   * passkey smart account; the Circle PIN/email wallet has no message-signing
   * capability wired up yet and this rejects for that case (see
   * docs/AUDIT_REPORT.md, Security #2/#7).
   */
  signMessage: (message: string) => Promise<`0x${string}`>;
};

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { network, networkId } = useNetwork();
  // wagmi carries the Reown connection (AppKit's adapter owns the wagmi config).
  const { address: wagmiAddr, connector } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [circle, setCircle] = useState<CircleSession | null>(null);
  // Rehydrate the email session so users stay logged in across reloads until
  // they disconnect or clear their browser. (Passkey sessions hold non-
  // serializable signer objects, so they re-auth on demand instead.)
  const [uc, setUc] = useState<UcSession | null>(() => loadUcSession());
  const [connecting, setConnecting] = useState(false);
  // Balance is stored WITH the network it was read on, so switching networks
  // shows "—" immediately (derived, no state update needed) instead of briefly
  // showing the previous chain's number.
  const [balanceFor, setBalanceFor] = useState<{ network: string; value: number | null }>({
    network: networkId,
    value: null,
  });
  const balance = balanceFor.network === networkId ? balanceFor.value : null;
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

  // Circle wallets only apply on networks configured for them (Arc). On BOT
  // Chain these are held but inactive.
  const circleActive = network.wallet.kind === "circle";
  const activeCircle = circleActive ? circle : null;
  const activeUc = circleActive ? uc : null;

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

  /** Reown AppKit modal, pointed at the active network. */
  const connectReown = useCallback(async () => {
    setConnecting(true);
    try {
      reownSwitchNetwork(network.chainId);
      await openReownModal();
    } finally {
      setConnecting(false);
    }
  }, [network.chainId]);

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
    const net = networkId;
    const set = (value: number | null) => setBalanceFor({ network: net, value });
    if (activeCircle) {
      circleUsdcBalance(activeCircle).then(set).catch(() => set(null));
    } else if (activeUc) {
      ucUsdcBalance(activeUc).then(set).catch(() => set(null));
    } else if (wagmiAddr) {
      // Reown-connected wallet: read the ACTIVE network's escrow asset, so
      // switching networks shows that chain's balance, never a stale or combined
      // one.
      usdcBalance(wagmiAddr, net).then(set).catch(() => set(null));
    } else {
      set(null);
    }
  }, [activeCircle, activeUc, wagmiAddr, networkId]);

  useEffect(() => {
    if (!activeCircle && !activeUc && !wagmiAddr) return;
    refreshBalance();
    const id = setInterval(refreshBalance, 15000);
    return () => clearInterval(id);
  }, [activeCircle, activeUc, wagmiAddr, networkId, refreshBalance]);

  const signMessage = useCallback(
    async (message: string): Promise<`0x${string}`> => {
      if (activeCircle) return circleSignMessage(activeCircle, message);
      if (wagmiAddr) return signMessageAsync({ message });
      if (activeUc)
        throw new Error(
          "The PIN wallet doesn't support message signing yet, use a passkey or a Reown-connected wallet for this action.",
        );
      throw new Error("No wallet connected");
    },
    [activeCircle, activeUc, wagmiAddr, signMessageAsync],
  );

  const escrow = network.assets.find((a) => a.isEscrowAsset);

  const value: Ctx = {
    address: (activeCircle?.address ?? activeUc?.address ?? wagmiAddr) as `0x${string}` | undefined,
    isConnected: Boolean(activeCircle || activeUc || wagmiAddr),
    circle: activeCircle,
    uc: activeUc,
    signer: activeCircle ?? activeUc,
    // Circle connect options are only offered on networks Circle supports.
    circleEnabled: circleActive && circleEnabled(),
    ucEnabled: circleActive && ucWalletEnabled(),
    connecting,
    walletKind: network.wallet.kind,
    // Our own wallet modes describe themselves honestly; an external wallet names itself.
    connectorName: circle ? "Passkey" : uc ? "PIN" : (connector?.name ?? null),
    balance,
    balanceSymbol: escrow?.symbol ?? network.chain.nativeCurrency.symbol,
    lastUsername,
    lastUcEmail,
    connect,
    connectEmailWallet,
    connectReown,
    reownEnabled: reownEnabled(),
    signMessage,
    disconnect: () => {
      setCircle(null);
      setUc(null);
      clearCachedCredential();
      reownDisconnect();
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
