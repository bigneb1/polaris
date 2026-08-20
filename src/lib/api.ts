import { resolveNetwork } from "./activeNetwork";
import { getNetwork, type NetworkId } from "./networks";

/**
 * Client for the Polaris verifier backend (server/server.js).
 *
 * The backend holds the trusted verifier signer key, runs the scoring, and
 * relays the signed verdict to VerifierBridge.sol. The frontend never sees the
 * signer key.
 *
 * EACH NETWORK HAS ITS OWN BACKEND. Arc's runtime drives Circle MPC agent wallets
 * and USDC escrow; BOT Chain's drives raw-key/ERC-4337 agents and native-BOT
 * escrow. They index different chains and hold different signers, so the base URL
 * comes from the network config (`apiBaseUrl`) — sending a BOT request to Arc's
 * runtime is a wrong address, not a slow path, and the backend now answers 409
 * rather than pretending the chain is empty.
 */

/** Base URL of the runtime that serves `network`, without a trailing slash. */
function base(network: NetworkId): string {
  return getNetwork(network).apiBaseUrl.replace(/\/$/, "");
}

/**
 * Every request carries the network it belongs to — both to pick the right
 * backend and because that backend keys its off-chain stores by chain id.
 * `network` defaults to the active one (see lib/activeNetwork.ts) rather than to
 * Arc, so a call site that forgets to pass it still behaves correctly for the
 * chain the user is looking at.
 */
function url(path: string, network?: NetworkId): string {
  const id = resolveNetwork(network);
  const sep = path.includes("?") ? "&" : "?";
  return `${base(id)}${path}${sep}network=${encodeURIComponent(id)}`;
}

/** Merge the network into a POST body. */
function body(payload: Record<string, unknown>, network?: NetworkId): string {
  return JSON.stringify({ ...payload, network: resolveNetwork(network) });
}

export type VerifyResult = {
  score: number;
  passed: boolean;
  reasoning: string;
  txHash?: string;
  /** released = USDC paid; rejected = sub-70, retry with feedback; slashed = late final fail. */
  status?: "released" | "rejected" | "slashed" | "settled";
  attempts?: number;
  attemptsLeft?: number;
  canRetry?: boolean;
  feedback?: string;
};

/**
 * Store a deliverable for a task (kept off-chain; only its score goes onchain).
 * `signature` (over `polaris-deliverable:{taskId}`, signed by the assigned
 * agent's own wallet) lets the backend verify this really came from that agent
 * — see docs/AUDIT_REPORT.md, Security #2. Omit it only if the connected
 * wallet can't sign off-chain messages (e.g. the Circle PIN wallet).
 */
export async function submitDeliverable(
  taskId: string,
  agentWallet: string,
  deliverable: string,
  signature?: string,
  network?: NetworkId,
) {
  const res = await fetch(url("/api/deliverable", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ taskId, agentWallet, deliverable, signature }, network),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to store deliverable");
  return res.json();
}

/* ── Hosted persona agents (Phase B) ─────────────────────────────────────────*/
export type HostedAgent = {
  id: string;
  name: string;
  capabilities: string[];
  owner: string | null;
  address: string;
  status: string;
  createdAtMs: number;
};
export async function createHostedAgent(
  input: { name: string; capabilities: string[]; systemPrompt: string; owner?: string },
  network?: NetworkId,
): Promise<{ address?: string; id?: string; stakeUsdc?: number; stakeSymbol?: string; error?: string }> {
  const res = await fetch(url("/api/hosted-agent", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body(input, network),
  });
  return res.json();
}
export async function getHostedAgents(owner?: string, network?: NetworkId): Promise<HostedAgent[]> {
  try {
    const res = await fetch(url(`/api/hosted-agents${owner ? `?owner=${owner}` : ""}`, network));
    if (!res.ok) return [];
    return (await res.json()).agents ?? [];
  } catch {
    return [];
  }
}

/** Trigger the AI jury to resolve an opened dispute (backend signs + settles on-chain). */
export async function resolveDispute(
  disputeId: string,
  reason: string,
  network?: NetworkId,
): Promise<{ upheld?: boolean; juryNote?: string; txHash?: string; error?: string }> {
  const res = await fetch(url("/api/dispute/resolve", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ disputeId, reason }, network),
  });
  return res.json();
}

/**
 * Submit a star rating + comment for an agent after a task completes.
 *
 * Signed, because every other field is public chain data: without a signature anyone could
 * file a rating as the requester and move an agent's public score.
 */
export async function submitRating(
  agent: string,
  taskId: string,
  rater: string,
  stars: number,
  comment: string,
  signMessage: (m: string) => Promise<string>,
  network?: NetworkId,
): Promise<{ ok?: boolean; error?: string }> {
  const signature = await signMessage(`polaris-rating:${taskId.toLowerCase()}`);
  const res = await fetch(url("/api/rating", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ agent, taskId, rater, stars, comment, signature }, network),
  });
  return res.json().catch(() => ({}));
}

/**
 * Flag an agent for platform review.
 *
 * Attributing a flag to a wallet requires proving that wallet signed it, so nobody can file
 * complaints in a stranger's name. A caller that cannot sign flags anonymously instead, which
 * the operator queue accepts.
 */
export async function flagAgent(
  agent: string,
  reason: string,
  reporter?: string,
  signMessage?: (m: string) => Promise<string>,
  network?: NetworkId,
): Promise<{ ok?: boolean; count?: number; error?: string }> {
  let signature: string | undefined;
  let attributed = reporter;
  if (reporter && signMessage) {
    try {
      signature = await signMessage(`polaris-flag:${agent.toLowerCase()}`);
    } catch {
      attributed = undefined; // declined to sign: file it anonymously rather than failing
    }
  } else {
    attributed = undefined;
  }
  const res = await fetch(url("/api/flag-agent", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ agent, reason, reporter: attributed, signature }, network),
  });
  return res.json();
}

export type DeliveryVerdict = { index: number; upheld: boolean; juryNote: string; complaint: string; atMs: number };
/** Dispute a specific delivery of a recurring plan — the AI jury re-judges it. */
export async function disputeRecurringDelivery(
  planId: string,
  index: number,
  complaint: string,
  reporter?: string,
  network?: NetworkId,
): Promise<{ upheld?: boolean; juryNote?: string; error?: string }> {
  const res = await fetch(url("/api/recurring-dispute", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ planId, index, complaint, reporter }, network),
  });
  return res.json();
}
/** Existing per-delivery dispute verdicts for a plan, keyed by delivery index. */
export async function getRecurringDisputes(
  planId: string,
  network?: NetworkId,
): Promise<Record<number, DeliveryVerdict>> {
  try {
    const res = await fetch(url(`/api/recurring-disputes/${planId}`, network));
    if (!res.ok) return {};
    return (await res.json()).disputes ?? {};
  } catch {
    return {};
  }
}

export type AgentRatings = { ratings: { taskId: string; rater: string; stars: number; comment: string; atMs: number }[]; avg: number; count: number };
export async function getRatings(agent: string, network?: NetworkId): Promise<AgentRatings> {
  try {
    const res = await fetch(url(`/api/ratings/${agent}`, network));
    if (!res.ok) return { ratings: [], avg: 0, count: 0 };
    return res.json();
  } catch {
    return { ratings: [], avg: 0, count: 0 };
  }
}

/** Operator-only: grant an agent a verification tier (backend holds the admin key). */
export async function adminSetBadge(
  secret: string,
  agent: string,
  tier: number,
  note: string,
  network?: NetworkId,
): Promise<{ txHash?: string; error?: string }> {
  const res = await fetch(url("/api/admin/set-badge", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ secret, agent, tier, note }, network),
  });
  return res.json();
}

/** Fetch a single recurring-subscription deliverable (full text + score). */
export async function getSubDeliverable(
  subId: string,
  index: number,
  network?: NetworkId,
): Promise<{ deliverable: string | null; score: number | null }> {
  try {
    const res = await fetch(url(`/api/sub-deliverable/${subId}/${index}`, network));
    if (!res.ok) return { deliverable: null, score: null };
    return res.json();
  } catch {
    return { deliverable: null, score: null };
  }
}

/** Fetch a single recurring-market plan deliverable (full text + score). */
export async function getPlanDeliverable(
  planId: string,
  index: number,
  network?: NetworkId,
): Promise<{ deliverable: string | null; score: number | null }> {
  try {
    const res = await fetch(url(`/api/recurring-deliverable/${planId}/${index}`, network));
    if (!res.ok) return { deliverable: null, score: null };
    return res.json();
  } catch {
    return { deliverable: null, score: null };
  }
}

/**
 * Upload a cover/avatar image (data URI) for a task (by taskId) or agent (by
 * wallet). Stored off-chain in the backend asset store and merged into the
 * index. Best-effort: a failure here never blocks the on-chain action.
 */
export async function uploadAsset(id: string, dataUri: string, network?: NetworkId): Promise<void> {
  try {
    await fetch(url("/api/asset", network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ id, dataUri }, network),
    });
  } catch {
    /* ignore - image is non-critical */
  }
}

/**
 * Store an agent's off-chain metadata (service endpoint URL + optional auth
 * header) keyed by wallet. This is how Polaris reaches the agent's runtime, which
 * lives off-chain. Best-effort: a failure never blocks the on-chain registration.
 */
export async function uploadAgentMeta(
  wallet: string,
  meta: { endpoint: string; auth?: string },
  network?: NetworkId,
): Promise<void> {
  try {
    await fetch(url("/api/agent-meta", network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ wallet, ...meta }, network),
    });
  } catch {
    /* ignore - endpoint metadata is non-critical to the on-chain registration */
  }
}

/** Read an image file into a compressed data URI suitable for upload. */
export function fileToDataUri(file: File, maxPx = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("invalid image"));
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/webp", 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export type ViewToken = { viewer: string; expiry: number; signature: string };

/**
 * Fetch a stored deliverable (if any) for a task. Requires a short-lived
 * signed token proving the caller is the task's requester or assigned agent
 * (server/server.js verifies it) — see docs/AUDIT_REPORT.md, Security #7.
 * Build one with `signDeliverableViewToken` below.
 */
export async function getDeliverable(
  taskId: string,
  token: ViewToken,
  network?: NetworkId,
): Promise<{ deliverable: string | null }> {
  const qs = new URLSearchParams({ viewer: token.viewer, expiry: String(token.expiry), signature: token.signature });
  const res = await fetch(url(`/api/deliverable/${taskId}?${qs}`, network));
  if (!res.ok) return { deliverable: null };
  return res.json();
}

const VIEW_TOKEN_TTL_MS = 10 * 60 * 1000; // backend allows up to 15 min; leave margin

/**
 * Sign (or reuse a cached, still-valid) short-lived token to view a task's
 * deliverable. Cached in sessionStorage per (taskId, viewer) so polling the
 * task-detail page doesn't re-prompt a signature every fetch.
 */
export async function signDeliverableViewToken(
  taskId: string,
  viewer: string,
  signMessage: (message: string) => Promise<string>,
): Promise<ViewToken> {
  const cacheKey = `polaris-view-token:${taskId.toLowerCase()}:${viewer.toLowerCase()}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null") as ViewToken | null;
    if (cached && cached.expiry > Date.now() + 30_000) return cached;
  } catch {
    /* fall through to signing a fresh one */
  }
  const expiry = Date.now() + VIEW_TOKEN_TTL_MS;
  const signature = await signMessage(`polaris-view:${taskId.toLowerCase()}:${expiry}`);
  const token: ViewToken = { viewer, expiry, signature };
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify(token));
  } catch {
    /* best-effort cache */
  }
  return token;
}

/**
 * Trigger verification: the backend scores the work, signs the verdict, and calls
 * VerifierBridge.submitVerification, which releases the escrow or slashes the stake.
 *
 * `signature` is required now. Scoring spends model credits and settling spends gas
 * from the verifier key, so the endpoint no longer accepts anonymous callers: sign
 * `polaris-verify:{taskId}` as either the task's assigned agent or its requester.
 * Pass a `signMessage` that uses the connected wallet; if that wallet cannot sign
 * off-chain messages (the Circle PIN wallet), the agent's own runtime settles the
 * task by itself moments later, and this call is only a manual nudge.
 */
export async function verifyTask(
  taskId: string,
  signMessage?: (message: string) => Promise<string>,
  network?: NetworkId,
): Promise<VerifyResult> {
  let signature: string | undefined;
  if (signMessage) {
    try {
      signature = await signMessage(`polaris-verify:${taskId.toLowerCase()}`);
    } catch {
      /* wallet refused or cannot sign; the request will be rejected and reported */
    }
  }
  const res = await fetch(url("/api/verify", network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ taskId, signature }, network),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Verification failed");
  return res.json();
}
