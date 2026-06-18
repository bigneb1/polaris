/**
 * Circle user-controlled wallets (PIN / email): the human "extra connect"
 * option alongside the passkey Modular Wallet.
 *
 * The entity secret + API key NEVER touch the browser. This module talks to the
 * Polaris backend (/api/uc/*) for the session token + challenge IDs, and runs
 * the PIN ceremony locally with @circle-fin/w3s-pw-web-sdk. Contract writes are
 * initiated on the backend as challenges and signed here with the user's PIN.
 */
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { createPublicClient, http, encodeFunctionData, erc20Abi, formatUnits, type Abi } from "viem";
import { arcTestnet, USDC_ADDRESS, USDC_DECIMALS, ARC_RPC_URL } from "./chain";

const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const API_URL = ENV.VITE_API_URL || "https://polaris-agent-runtime-production.up.railway.app";
const APP_ID = ENV.VITE_CIRCLE_UC_APP_ID || "";

export function ucWalletEnabled(): boolean {
  return Boolean(API_URL && APP_ID);
}

export type UcSession = {
  kind: "uc";
  userToken: string;
  encryptionKey: string;
  walletId: string;
  address: `0x${string}`;
  /** Present for email-OTP logins; used only for display / re-login prefill. */
  email?: string;
  /** Present for legacy PIN logins. */
  userId?: string;
};

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC_URL) });

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `request to ${path} failed`);
  return r.json() as Promise<T>;
}

/** The Polaris brand mark, served from the app origin (falls back gracefully). */
function brandLogo(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/polaris-mark.svg`;
}

/** Apply Polaris branding (logo, palette, typography, copy) to the PIN ceremony. */
function brandSdk(sdk: W3SSdk): void {
  const logo = brandLogo();

  // Palette mirrors the Polaris light theme: white surfaces, blue/violet accents.
  sdk.setThemeColor({
    backdrop: "#0B1020",
    backdropOpacity: 0.6,
    bg: "#FFFFFF",
    divider: "#E2E6EC",
    textMain: "#101622",
    textMain2: "#101622",
    textAuxiliary: "#56647A",
    textAuxiliary2: "#8E9AAC",
    textSummary: "#101622",
    textSummaryHighlight: "#256EE6",
    textPlaceholder: "#8E9AAC",
    textInteractive: "#256EE6",
    textDetailToggle: "#256EE6",
    success: "#0D9464",
    error: "#DC3232",
    pinDotBase: "#FFFFFF",
    pinDotBaseBorder: "#D0D6E0",
    pinDotActivated: "#256EE6",
    enteredPinText: "#101622",
    inputText: "#101622",
    inputBorderFocused: "#256EE6",
    inputBorderFocusedError: "#DC3232",
    inputBg: "#F6F7F9",
  });

  sdk.setResources({
    securityIntroMain: logo,
    emailIcon: logo,
    dAppIcon: logo,
    fontFamily: {
      name: "Outfit",
      url: "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap",
    },
  });

  sdk.setLocalizations({
    common: { continue: "Continue", confirm: "Confirm", sign: "Approve", retry: "Try again" },
    initPincode: {
      headline: "Secure your Polaris wallet",
      subhead: "Set a 6-digit PIN. It protects your wallet and signs your transactions on Arc.",
    },
    confirmInitPincode: {
      headline: "Confirm your PIN",
      subhead: "Re-enter your PIN to finish creating your Polaris wallet.",
    },
    enterPincode: {
      headline: "Enter your Polaris PIN",
      subhead: "Confirm this action with the PIN you set for your wallet.",
    },
  });
}

/**
 * The Circle PIN SDK bundles Node-oriented deps (jsonwebtoken, dotenv) that
 * reference process/Buffer and crash if evaluated at app startup. We import it
 * lazily here so it is code-split out of the entry bundle and only loaded when
 * the user actually opens the PIN wallet flow.
 */
async function makeSdk(userToken: string, encryptionKey: string): Promise<W3SSdk> {
  const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
  const sdk = new W3SSdk();
  sdk.setAppSettings({ appId: APP_ID });
  sdk.setAuthentication({ userToken, encryptionKey });
  brandSdk(sdk);
  return sdk;
}

/** Run a Circle challenge (PIN ceremony / tx signing). Resolves on success. */
function runChallenge(sdk: W3SSdk, challengeId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sdk.execute(challengeId, (error) => {
      if (error) reject(new Error(error.message || "challenge failed"));
      else resolve();
    });
  });
}

async function fetchWallet(userId: string): Promise<{ walletId: string; address: `0x${string}` }> {
  // The wallet may take a moment to materialize after the ceremony.
  for (let i = 0; i < 8; i++) {
    const w = await api<{ walletId?: string; address?: string }>(`/api/uc/wallet?userId=${encodeURIComponent(userId)}`);
    if (w.walletId && w.address) return { walletId: w.walletId, address: w.address as `0x${string}` };
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("wallet not ready");
}

/** First-time connect: create user, set a PIN, create the Arc wallet. */
export async function registerUserWallet(): Promise<UcSession> {
  if (!ucWalletEnabled()) throw new Error("Circle user wallet not configured");
  const sess = await api<{ userId: string; userToken: string; encryptionKey: string }>("/api/uc/session", {});
  const { challengeId } = await api<{ challengeId: string }>("/api/uc/init", { userId: sess.userId });
  const sdk = await makeSdk(sess.userToken, sess.encryptionKey);
  await runChallenge(sdk, challengeId);
  const wallet = await fetchWallet(sess.userId);
  return { kind: "uc", ...sess, ...wallet };
}

/** Returning user (this browser remembered the userId): mint a fresh token. */
export async function loginUserWallet(userId: string): Promise<UcSession> {
  if (!ucWalletEnabled()) throw new Error("Circle user wallet not configured");
  const sess = await api<{ userId: string; userToken: string; encryptionKey: string }>("/api/uc/refresh", { userId });
  const wallet = await fetchWallet(userId);
  return { kind: "uc", ...sess, ...wallet };
}

/** Poll for the Arc wallet addressed by a post-login userToken. */
async function walletByToken(userToken: string): Promise<{ walletId: string; address: `0x${string}` } | null> {
  const w = await api<{ walletId?: string; address?: string }>("/api/uc/wallet-by-token", { userToken });
  return w.walletId && w.address ? { walletId: w.walletId, address: w.address as `0x${string}` } : null;
}

/**
 * Email-OTP connect (the auth mode enabled in the Circle Console).
 *
 * Browser getDeviceId() -> backend emails the OTP -> Circle's verifyOtp() UI
 * collects the code -> onLoginComplete yields a userToken -> we look up (or
 * create) the user's Arc wallet. No PIN is involved.
 */
export async function connectEmailWallet(email: string): Promise<UcSession> {
  if (!ucWalletEnabled()) throw new Error("Circle user wallet not configured");
  if (!email.trim()) throw new Error("Enter your email");
  const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");

  // onLoginComplete delivers the authenticated session token.
  let resolveLogin!: (r: { userToken: string; encryptionKey: string }) => void;
  let rejectLogin!: (e: Error) => void;
  const loginDone = new Promise<{ userToken: string; encryptionKey: string }>((res, rej) => {
    resolveLogin = res;
    rejectLogin = rej;
  });
  const onLoginComplete = (
    error: { message?: string } | undefined,
    result: { userToken?: string; encryptionKey?: string } | undefined,
  ) => {
    if (error) rejectLogin(new Error(error.message || "Email login failed"));
    else if (result?.userToken && result.encryptionKey)
      resolveLogin({ userToken: result.userToken, encryptionKey: result.encryptionKey });
    else rejectLogin(new Error("Email login returned no session"));
  };

  const sdk = new W3SSdk({ appSettings: { appId: APP_ID } }, onLoginComplete);
  brandSdk(sdk);

  const deviceId = await sdk.getDeviceId();
  const { deviceToken, deviceEncryptionKey, otpToken } = await api<{
    deviceToken: string;
    deviceEncryptionKey: string;
    otpToken: string;
  }>("/api/uc/email-token", { deviceId, email: email.trim() });

  sdk.updateConfigs(
    { appSettings: { appId: APP_ID }, loginConfigs: { deviceToken, deviceEncryptionKey, otpToken } },
    onLoginComplete,
  );
  sdk.verifyOtp();

  const { userToken, encryptionKey } = await loginDone;

  // User-controlled wallets are PIN-secured by design; email is just the login
  // method. On first login the user has no wallet yet, so we run the
  // "set PIN + create wallet" ceremony (createUserPinWithWallets). On later
  // logins the wallet already exists and we skip straight to it.
  let wallet = await walletByToken(userToken);
  if (!wallet) {
    const { challengeId } = await api<{ challengeId: string }>("/api/uc/pin-setup", { userToken });
    sdk.setAuthentication({ userToken, encryptionKey });
    await runChallenge(sdk, challengeId); // user sets a 6-digit PIN, wallet is created
    for (let i = 0; i < 20 && !wallet; i++) {
      wallet = await walletByToken(userToken);
      if (!wallet) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!wallet) throw new Error("Wallet not ready, please try again");
  return { kind: "uc", userToken, encryptionKey, walletId: wallet.walletId, address: wallet.address, email: email.trim() };
}

/** USDC balance (human units) of the user wallet. */
export async function ucUsdcBalance(session: UcSession): Promise<number> {
  const raw = (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [session.address],
  })) as bigint;
  return Number(formatUnits(raw, USDC_DECIMALS));
}

type Call = { address: `0x${string}`; abi: Abi; functionName: string; args: readonly unknown[] };

/**
 * Execute a single contract write from the user wallet: the backend builds a
 * contract-execution challenge, the user signs it here with their PIN. Circle
 * sponsors gas (SCA), so no native balance is required.
 *
 * Circle's challenge takes an ABI function signature + string params, so we
 * derive the human signature from the call and stringify the args.
 */
export async function ucWrite(session: UcSession, call: Call): Promise<void> {
  const abiFunctionSignature = humanSignature(call);
  const abiParameters = call.args.map((a) => (typeof a === "bigint" ? a.toString() : a));
  // Validate encodability up-front (throws clearly if the call is malformed).
  encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
  const { challengeId } = await api<{ challengeId: string }>("/api/uc/execute", {
    userToken: session.userToken,
    userId: session.userId,
    walletId: session.walletId,
    contractAddress: call.address,
    abiFunctionSignature,
    abiParameters,
  });
  const sdk = await makeSdk(session.userToken, session.encryptionKey);
  await runChallenge(sdk, challengeId);
}

/** Build a Solidity human-readable function signature, e.g. placeBid(bytes32,uint256,uint256). */
function humanSignature(call: Call): string {
  const frag = (call.abi as Array<{ type?: string; name?: string; inputs?: Array<{ type: string }> }>).find(
    (f) => f.type === "function" && f.name === call.functionName,
  );
  if (!frag?.inputs) throw new Error(`ABI missing function ${call.functionName}`);
  return `${call.functionName}(${frag.inputs.map((i) => i.type).join(",")})`;
}
