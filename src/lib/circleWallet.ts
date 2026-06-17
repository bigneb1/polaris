/**
 * Circle Modular Wallets - passkey-secured smart accounts on Arc, gasless via
 * Circle's paymaster. Implemented per the official quickstart:
 * https://developers.circle.com/wallets/modular/create-a-wallet-and-send-gasless-txn
 *
 * Gated on VITE_CIRCLE_CLIENT_KEY + VITE_CIRCLE_CLIENT_URL; when absent the UI
 * hides the Circle option. Nothing runs at import time so the build stays green.
 */
import {
  toPasskeyTransport,
  toWebAuthnCredential,
  toModularTransport,
  toCircleSmartAccount,
  encodeTransfer,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, erc20Abi, formatUnits } from "viem";
import { toWebAuthnAccount, createBundlerClient } from "viem/account-abstraction";
import { arcTestnet, USDC_ADDRESS, USDC_DECIMALS } from "./chain";

const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const CLIENT_KEY = ENV.VITE_CIRCLE_CLIENT_KEY || "";
const CLIENT_URL = ENV.VITE_CIRCLE_CLIENT_URL || "";
const CHAIN_PATH = ENV.VITE_CIRCLE_CHAIN_PATH || "arcTestnet";

export function circleEnabled(): boolean {
  return Boolean(CLIENT_KEY && CLIENT_URL);
}

export type CircleSession = {
  address: `0x${string}`;
  username: string;
  bundler: ReturnType<typeof createBundlerClient>;
  account: Awaited<ReturnType<typeof toCircleSmartAccount>>;
  publicClient: ReturnType<typeof createPublicClient>;
};

function makeConnect(mode: WebAuthnMode) {
  return async (username: string): Promise<CircleSession> => {
    if (!circleEnabled()) throw new Error("Circle wallet not configured (set VITE_CIRCLE_CLIENT_KEY/URL).");

    const passkeyTransport = toPasskeyTransport(CLIENT_URL, CLIENT_KEY);
    const credential = await toWebAuthnCredential({ transport: passkeyTransport, mode, username });

    const modularTransport = toModularTransport(`${CLIENT_URL}/${CHAIN_PATH}`, CLIENT_KEY);
    const publicClient = createPublicClient({ chain: arcTestnet, transport: modularTransport });

    const account = await toCircleSmartAccount({
      client: publicClient,
      owner: toWebAuthnAccount({ credential }),
    });

    const bundler = createBundlerClient({
      account,
      chain: arcTestnet,
      transport: modularTransport,
    });

    return { address: account.address as `0x${string}`, username, bundler, account, publicClient };
  };
}

export const registerCircleWallet = makeConnect(WebAuthnMode.Register);
export const loginCircleWallet = makeConnect(WebAuthnMode.Login);

/** USDC balance (human units) for the connected smart account. */
export async function circleUsdcBalance(session: CircleSession): Promise<number> {
  const raw = (await session.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [session.address],
  })) as bigint;
  return Number(formatUnits(raw, USDC_DECIMALS));
}

/** Send a gasless USDC transfer (paymaster-sponsored). */
export async function circleSendUsdc(
  session: CircleSession,
  to: `0x${string}`,
  amount: number,
): Promise<`0x${string}`> {
  const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  const hash = await session.bundler.sendUserOperation({
    account: session.account,
    calls: [encodeTransfer(to, USDC_ADDRESS, units)],
    paymaster: true,
  });
  const { receipt } = await session.bundler.waitForUserOperationReceipt({ hash });
  return receipt.transactionHash as `0x${string}`;
}
