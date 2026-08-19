import { timingSafeEqual } from "node:crypto";
import { verifyAgentSignature } from "./auth.js";

/**
 * Access control for the endpoints that cost real money.
 *
 * `/api/verify` was open to the internet. Anyone who knew a task id could make the
 * runtime call the LLM (paid credits), send settlement transactions (gas from the
 * verifier key) and publish ERC-8004 transactions, with no authentication and no
 * rate limit anywhere in the server. A short per-task cooldown was the only brake,
 * so a script iterating task ids could drain both the signer's gas and the model
 * budget.
 *
 * Two mechanisms, because no single one covers every legitimate caller:
 *
 *  1. **Internal secret.** The runtime's own processes (swarm, hosted personas,
 *     schedulers) send `x-polaris-internal`. This is the ONLY option available to
 *     the Circle swarm: Circle MPC agent wallets expose on-chain execution but no
 *     off-chain message signing, so those agents cannot produce a signature at all.
 *  2. **Signature.** Anyone else must prove they are a party to the task, by signing
 *     `polaris-verify:{taskId}` as either the assigned agent or the requester. Both
 *     are on-chain facts, so this cannot be spoofed, and `verifyAgentSignature`
 *     already falls back to ERC-1271, which is what lets an ERC-4337 agent account
 *     authorise its own settlement.
 *
 * Neither present means 401. Failing closed is right here: the fallback is that the
 * agent's own runtime settles the task moments later anyway.
 */

/** Constant-time compare that tolerates absent or unequal-length input. */
function secretMatches(provided, expected) {
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when a request carries the runtime's internal secret. */
export function isInternal(req) {
  const expected = process.env.INTERNAL_API_SECRET;
  // With no secret configured there is nothing to match, so internal callers fall
  // through to the signature path rather than everyone being treated as internal.
  if (!expected) return false;
  return secretMatches(req.get("x-polaris-internal") || "", expected);
}

/**
 * Authorise a verification request.
 *
 * @returns {Promise<{ok: true, via: string} | {ok: false, status: number, error: string}>}
 */
export async function authorizeVerify(req, ctx, { taskId, agent, requester }) {
  if (isInternal(req)) return { ok: true, via: "internal" };

  const signature = req.body?.signature;
  if (!signature) {
    return {
      ok: false,
      status: 401,
      error:
        "Verification requires authorisation: sign `polaris-verify:<taskId>` as the assigned agent or the task's requester, or call from the runtime with the internal secret.",
    };
  }

  const message = `polaris-verify:${String(taskId).toLowerCase()}`;
  for (const [role, address] of [
    ["agent", agent],
    ["requester", requester],
  ]) {
    if (!address) continue;
    // Each check is a chain read for the contract-wallet case, so stop at the first
    // match rather than always testing both.
    if (await verifyAgentSignature(message, signature, address, ctx.provider)) {
      return { ok: true, via: role };
    }
  }
  return {
    ok: false,
    status: 403,
    error: "That signature is not from this task's assigned agent or its requester.",
  };
}

/**
 * Fixed-window per-IP rate limiter.
 *
 * In-memory on purpose: each network runs a single-replica service, so there is no
 * shared state to coordinate, and a limiter that needs a database would be one more
 * thing that can fail on the settlement path. It bounds abuse; it is not a defence
 * against a distributed attacker, which would need a proxy-level control.
 */
export function rateLimit({ windowMs = 60_000, max = 30, name = "endpoint" } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  return function limiter(req, res, next) {
    // The runtime's own calls are not part of anyone's quota.
    if (isInternal(req)) return next();

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    // Bound the map so a spray of source addresses cannot grow it without limit.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now > v.resetAt) hits.delete(k);
        if (hits.size <= 2500) break;
      }
    }

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: `Too many ${name} requests. Try again in ${retryAfter}s.`,
      });
    }
    return next();
  };
}
