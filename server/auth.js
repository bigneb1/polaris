import { ethers } from "ethers";
import { timingSafeEqual } from "node:crypto";
import { provider as arcProvider } from "./chain.js";

/**
 * Verifies that `expectedAddress` produced `signature` over `message`.
 *
 * Tries a plain EOA (EIP-191 personal_sign) recovery first, then falls back to
 * ERC-1271 (`isValidSignature`) for smart-contract wallets: Circle Modular passkey
 * accounts on Arc, and PolarisAccount (ERC-4337) agents on BOT Chain, which cannot
 * ECDSA-sign at all and must prove authorship this way.
 *
 * `provider` MUST be the provider for the network the address lives on. It used to
 * default to Arc's unconditionally, which meant an ERC-1271 check for a BOT Chain
 * account queried Arc, found no contract, and rejected a perfectly valid signature.
 */
export async function verifyAgentSignature(message, signature, expectedAddress, provider = arcProvider) {
  if (!signature || !expectedAddress) return false;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) return true;
  } catch {
    /* not a recoverable ECDSA signature, try ERC-1271 below */
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
