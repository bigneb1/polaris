import { initiateUserControlledWalletsClient } from "@circle-fin/user-controlled-wallets";
import { randomUUID } from "node:crypto";
import "dotenv/config";

/**
 * Circle user-controlled wallets (PIN/email) for Polaris — the human-side
 * "extra connect" option alongside the passkey Modular Wallet.
 *
 * The entity secret + API key live ONLY here on the backend. The browser runs
 * the PIN ceremony with @circle-fin/w3s-pw-web-sdk using a short-lived userToken
 * + encryptionKey that this module mints. Contract writes (submitTask, placeBid,
 * ...) are initiated here as challenges and signed by the user with their PIN.
 *
 * Arc testnet is supported by the user-controlled wallets API (verified), so the
 * wallet created is a real Arc account that can hold USDC and call the contracts.
 */
const API_KEY = process.env.CIRCLE_UC_API_KEY;
const ENTITY_SECRET = process.env.CIRCLE_UC_ENTITY_SECRET;
const BLOCKCHAIN = process.env.CIRCLE_UC_BLOCKCHAIN || "ARC-TESTNET";
const ACCOUNT_TYPE = process.env.CIRCLE_UC_ACCOUNT_TYPE || "SCA"; // gasless smart account

let client = null;
export function ucEnabled() {
  return Boolean(API_KEY && ENTITY_SECRET);
}
function uc() {
  if (!ucEnabled()) throw new Error("Circle user-controlled wallets not configured");
  if (!client) client = initiateUserControlledWalletsClient({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
  return client;
}

/** Create a fresh user + session token. The browser uses these to run the ceremony. */
export async function createSession() {
  const c = uc();
  const userId = `polaris-${randomUUID()}`;
  await c.createUser({ userId });
  const tok = await c.createUserToken({ userId });
  return { userId, userToken: tok.data.userToken, encryptionKey: tok.data.encryptionKey };
}

/** Mint a fresh session token for an existing user (re-login). */
export async function refreshSession(userId) {
  const c = uc();
  const tok = await c.createUserToken({ userId });
  return { userId, userToken: tok.data.userToken, encryptionKey: tok.data.encryptionKey };
}

/** Challenge that sets the PIN and creates the Arc wallet in one ceremony. */
export async function initChallenge(userId) {
  const c = uc();
  const res = await c.createUserPinWithWallets({
    userId,
    blockchains: [BLOCKCHAIN],
    accountType: ACCOUNT_TYPE,
  });
  return { challengeId: res.data.challengeId };
}

/** The user's Arc wallet (id + address), once the ceremony has completed. */
export async function getWallet(userId) {
  const c = uc();
  const res = await c.listWallets({ userId, blockchain: BLOCKCHAIN });
  const w = res.data?.wallets?.[0];
  if (!w) return null;
  return { walletId: w.id, address: w.address, state: w.state };
}

/**
 * Initiate a contract write from the user's wallet. Returns a challengeId the
 * browser signs with the user's PIN. callData is an ABI function signature +
 * positional parameters (Circle encodes them).
 */
export async function contractExecutionChallenge(userId, walletId, contractAddress, abiFunctionSignature, abiParameters) {
  const c = uc();
  const res = await c.createUserTransactionContractExecutionChallenge({
    userId,
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  return { challengeId: res.data.challengeId };
}
