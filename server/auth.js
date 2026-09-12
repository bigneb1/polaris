import { ethers } from "ethers";
import { timingSafeEqual } from "node:crypto";
import { provider } from "./chain.js";

/**
 * Verifies that `expectedAddress` produced `signature` over `message`.
 * Tries a plain EOA (EIP-191 personal_sign) recovery first, then falls back to
 * ERC-1271 (`isValidSignature`) for smart-contract wallets (e.g. Circle Modular
 * passkey accounts) — the account must already be deployed on-chain, which is
 * true by the time an agent has bid/been assigned a task.
 */
export async function verifyAgentSignature(message, signature, expectedAddress) {
  if (!signature || !expectedAddress) return false;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) return true;
  } catch {
    /* not a recoverable ECDSA signature — try ERC-1271 below */
  }
  try {
    const hash = ethers.hashMessage(message);
    const c = new ethers.Contract(
      expectedAddress,
      ["function isValidSignature(bytes32,bytes) view returns (bytes4)"],
      provider,
    );
    const result = await c.isValidSignature(hash, signature);
    return result === "0x1626ba7e";
  } catch {
    return false;
  }
}

/** Constant-time secret compare — avoids a naive `!==` timing side-channel. */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
