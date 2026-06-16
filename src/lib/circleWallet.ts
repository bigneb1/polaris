/**
 * Circle Modular Wallets — passkey-secured ERC-4337 smart accounts on Arc.
 *
 * Lets a human create/log in a wallet with a passkey (no seed phrase) and
 * transact gaslessly via Circle's Gas Station + bundler. Arc testnet is
 * supported by Circle Modular Wallets (chain path `arcTestnet`).
 *
 * Entirely gated on VITE_CIRCLE_CLIENT_KEY + VITE_CIRCLE_CLIENT_URL — when those
 * are absent the UI hides the Circle option and the rest of the app is unaffected.
 * Nothing here runs at import time, so the build stays green without credentials.
 */
import {
  toPasskeyTransport,
  toWebAuthnCredential,
  toModularTransport,
  toCircleSmartAccount,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient } from "viem";
import { toWebAuthnAccount, createBundlerClient } from "viem/account-abstraction";
import { arcTestnet } from "./chain";

const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const CLIENT_KEY = ENV.VITE_CIRCLE_CLIENT_KEY || "";
const CLIENT_URL = ENV.VITE_CIRCLE_CLIENT_URL || "";
const CHAIN_PATH = ENV.VITE_CIRCLE_CHAIN_PATH || "arcTestnet";

/** Whether Circle Modular Wallets is configured for this build. */
export function circleEnabled(): boolean {
  return Boolean(CLIENT_KEY && CLIENT_URL);
}

export type CircleSession = {
  address: `0x${string}`;
  // The bundler client used to send gasless user operations.
  // Typed loosely to avoid leaking the SDK's internal generics through the app.
  bundler: ReturnType<typeof createBundlerClient>;
  account: Awaited<ReturnType<typeof toCircleSmartAccount>>;
};

function transports() {
  const passkey = toPasskeyTransport(CLIENT_URL, CLIENT_KEY);
  const modular = toModularTransport(`${CLIENT_URL}/${CHAIN_PATH}`, CLIENT_KEY);
  return { passkey, modular };
}

/** Register a brand-new passkey + Circle smart account for `username`. */
export async function registerCircleWallet(username: string): Promise<CircleSession> {
  return connect(username, WebAuthnMode.Register);
}

/** Log in to an existing passkey + Circle smart account. */
export async function loginCircleWallet(username: string): Promise<CircleSession> {
  return connect(username, WebAuthnMode.Login);
}

async function connect(username: string, mode: WebAuthnMode): Promise<CircleSession> {
  if (!circleEnabled()) throw new Error("Circle Modular Wallets not configured (set VITE_CIRCLE_CLIENT_KEY/URL).");
  const { passkey, modular } = transports();

  const credential = await toWebAuthnCredential({ transport: passkey, mode, username });

  const client = createPublicClient({ chain: arcTestnet, transport: modular });
  const account = await toCircleSmartAccount({
    client,
    owner: toWebAuthnAccount({ credential }),
    name: username,
  });

  const bundler = createBundlerClient({
    account,
    chain: arcTestnet,
    transport: modular,
  });

  return { address: account.address as `0x${string}`, bundler, account };
}

/**
 * Send a gasless user operation (Circle Gas Station sponsors fees).
 * @param session a CircleSession from register/login
 * @param calls   viem call objects: { to, abi?, functionName?, args?, value? }
 */
export async function sendGasless(
  session: CircleSession,
  calls: { to: `0x${string}`; data?: `0x${string}`; value?: bigint }[],
): Promise<`0x${string}`> {
  const hash = await session.bundler.sendUserOperation({
    account: session.account,
    calls,
    paymaster: true,
  });
  const receipt = await session.bundler.waitForUserOperationReceipt({ hash });
  return receipt.receipt.transactionHash as `0x${string}`;
}
