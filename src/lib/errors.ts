/**
 * Turn raw wallet / RPC / contract errors into short, human messages.
 *
 * viem, wagmi and the Circle bundler throw verbose multi-line errors with stack
 * traces, ABI dumps, "Version: viem@x.y.z" footers and request payloads. Surfacing
 * those in a toast looks broken. This module extracts the one useful line (a
 * contract revert reason, a user rejection, or a network failure) and maps it to
 * plain language. Everything unrecognized falls back to a clean generic message.
 */

type AnyErr = {
  code?: number | string;
  name?: string;
  reason?: string;
  shortMessage?: string;
  details?: string;
  message?: string;
  cause?: unknown;
};

/** Friendly text for the Solidity require() strings used across the contracts. */
const REVERT_MAP: Record<string, string> = {
  "Below min stake (100 USDC)": "You need to stake at least 100 USDC to register an agent.",
  "Already registered": "This wallet already has a registered agent.",
  "agentId taken": "That agent name is already taken. Try another.",
  "USDC transferFrom failed": "USDC transfer failed. Check your balance and allowance.",
  "Agent reputation below 70": "This agent's reputation is below the 70 floor required to bid.",
  "Agent offline": "That agent is offline and cannot be hired right now.",
  "Deadline in past": "The deadline must be in the future.",
  "Zero budget": "Set a task budget greater than zero.",
  "Task exists": "A task with this id already exists.",
  "Not authorized": "This wallet is not authorized for that action.",
  "Auction closed": "Bidding on this task has already closed.",
  "Has active tasks": "Finish or settle in-flight tasks before going offline.",
  "Insufficient allowance": "Approve USDC spending first, then try again.",
};

/** Walk the cause chain collecting candidate message strings. */
function collect(err: unknown, out: string[] = [], depth = 0): string[] {
  if (!err || depth > 6) return out;
  const e = err as AnyErr;
  for (const v of [e.reason, e.shortMessage, e.details, e.message]) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  if (e.cause) collect(e.cause, out, depth + 1);
  return out;
}

/** Extract a Solidity revert reason from any of the collected strings. */
function revertReason(strings: string[]): string | null {
  for (const s of strings) {
    const m =
      s.match(/reverted with the following reason:\s*\n?\s*(.+)/i) ||
      s.match(/execution reverted:?\s*"?([^"\n]+)"?/i) ||
      s.match(/reason:\s*"?([^"\n]+)"?/i);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function looksLikeUserRejection(strings: string[], code?: number | string): boolean {
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  return strings.some((s) => /user (rejected|denied)|rejected the request|denied (the )?(transaction|signature)|cancell?ed/i.test(s));
}

function looksLikeNetwork(strings: string[]): boolean {
  return strings.some((s) =>
    /network|timeout|timed out|fetch failed|failed to fetch|ECONNRESET|503|502|gateway|rpc|connection/i.test(s),
  );
}

/** First clean sentence of a string: drop viem footers, payloads, stack noise. */
function firstClean(s: string): string {
  const line = s
    .split("\n")[0]
    .replace(/\b(viem|wagmi)@?[\w.@/-]*/gi, "")
    .replace(/Version:.*/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/0x[0-9a-fA-F]{12,}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return line;
}

/**
 * Map any thrown error to a short, user-facing message.
 * @param fallback default text when nothing useful can be extracted.
 */
export function humanizeError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const e = err as AnyErr;
  const strings = collect(err);

  if (looksLikeUserRejection(strings, e.code)) return "Cancelled.";

  const reason = revertReason(strings);
  if (reason) return REVERT_MAP[reason] ?? `Transaction reverted: ${reason}`;

  if (looksLikeNetwork(strings)) return "Network issue reaching Arc. Please try again in a moment.";

  // Backend (Circle / verifier) errors already arrive as clean single-line messages.
  for (const s of strings) {
    const clean = firstClean(s);
    // Skip noisy library boilerplate; surface a genuinely human sentence.
    if (
      clean &&
      clean.length <= 140 &&
      !/^the contract function/i.test(clean) &&
      !/abi|encodefunctiondata|useroperation|estimateGas|^request|^contract call|^raw|^data:/i.test(clean)
    ) {
      return clean;
    }
  }

  return fallback;
}

/** True if the error is just the user dismissing a wallet prompt. */
export function isUserRejection(err: unknown): boolean {
  const e = err as AnyErr;
  return looksLikeUserRejection(collect(err), e.code);
}
