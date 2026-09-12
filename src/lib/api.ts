/**
 * Client for the Polaris verifier backend (backend/server.js).
 *
 * The backend submits evidence to GenLayer, waits for validator consensus and
 * finality, then uses a narrow relay key to transport that decision to Arc's
 * VerifierBridge.sol. If VITE_API_URL is unset we assume the backend is served
 * on the same origin under /api.
 */
const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const API_URL = ENV.VITE_API_URL || "https://polaris-agent-runtime-production-170d.up.railway.app";

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
  genlayerTxHash?: string;
  genlayerDecisionId?: string;
};

/**
 * Store a deliverable for a task (kept off-chain; only its score goes onchain).
 * `signature` (over `polaris-deliverable:{taskId}`, signed by the assigned
 * agent's own wallet) lets the backend verify this really came from that agent
 * — see docs/AUDIT_REPORT.md, Security #2. Omit it only if the connected
 * wallet can't sign off-chain messages (e.g. the Circle PIN wallet).
 */
export async function submitDeliverable(taskId: string, agentWallet: string, deliverable: string, signature?: string) {
  const res = await fetch(`${API_URL}/api/deliverable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, agentWallet, deliverable, signature }),
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
export async function createHostedAgent(input: { name: string; capabilities: string[]; systemPrompt: string; owner?: string }): Promise<{ address?: string; id?: string; stakeUsdc?: number; error?: string }> {
  const res = await fetch(`${API_URL}/api/hosted-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json();
}
export async function getHostedAgents(owner?: string): Promise<HostedAgent[]> {
  try {
    const res = await fetch(`${API_URL}/api/hosted-agents${owner ? `?owner=${owner}` : ""}`);
    if (!res.ok) return [];
    return (await res.json()).agents ?? [];
  } catch {
    return [];
  }
}

/** Trigger the GenLayer validator jury, then relay its final decision to Arc. */
export async function resolveDispute(disputeId: string, reason: string): Promise<{ upheld?: boolean; juryNote?: string; txHash?: string; genlayerTxHash?: string; genlayerDecisionId?: string; error?: string }> {
  const res = await fetch(`${API_URL}/api/dispute/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disputeId, reason }),
  });
  return res.json();
}

/** Submit a star rating + comment for an agent after a task completes. */
export async function submitRating(agent: string, taskId: string, rater: string, stars: number, comment: string): Promise<void> {
  await fetch(`${API_URL}/api/rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, taskId, rater, stars, comment }),
  });
}

/** Flag an agent for platform review with a reason. */
export async function flagAgent(agent: string, reason: string, reporter?: string): Promise<{ ok?: boolean; count?: number; error?: string }> {
  const res = await fetch(`${API_URL}/api/flag-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, reason, reporter }),
  });
  return res.json();
}

export type DeliveryVerdict = { index: number; upheld: boolean; juryNote: string; complaint: string; genLayerDecisionId?: string; genlayerTxHash?: string; atMs: number };
/** Dispute a specific delivery of a recurring plan — the AI jury re-judges it. */
export async function disputeRecurringDelivery(planId: string, index: number, complaint: string, reporter?: string): Promise<{ upheld?: boolean; juryNote?: string; genLayerDecisionId?: string; genlayerTxHash?: string; error?: string }> {
  const res = await fetch(`${API_URL}/api/recurring-dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, index, complaint, reporter }),
  });
  return res.json();
}
/** Existing per-delivery dispute verdicts for a plan, keyed by delivery index. */
export async function getRecurringDisputes(planId: string): Promise<Record<number, DeliveryVerdict>> {
  try {
    const res = await fetch(`${API_URL}/api/recurring-disputes/${planId}`);
    if (!res.ok) return {};
    return (await res.json()).disputes ?? {};
  } catch {
    return {};
  }
}

/** How many open flags an agent has (surface an "under review" hint). */
export async function getFlagCount(agent: string): Promise<number> {
  try {
    const res = await fetch(`${API_URL}/api/flags/${agent}`);
    if (!res.ok) return 0;
    return (await res.json()).count ?? 0;
  } catch {
    return 0;
  }
}

export type AgentRatings = { ratings: { taskId: string; rater: string; stars: number; comment: string; atMs: number }[]; avg: number; count: number };
export async function getRatings(agent: string): Promise<AgentRatings> {
  try {
    const res = await fetch(`${API_URL}/api/ratings/${agent}`);
    if (!res.ok) return { ratings: [], avg: 0, count: 0 };
    return res.json();
  } catch {
    return { ratings: [], avg: 0, count: 0 };
  }
}

/** Operator-only: grant an agent a verification tier (backend holds the admin key). */
export async function adminSetBadge(secret: string, agent: string, tier: number, note: string): Promise<{ txHash?: string; error?: string }> {
  const res = await fetch(`${API_URL}/api/admin/set-badge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, agent, tier, note }),
  });
  return res.json();
}

/** Fetch a single recurring-subscription deliverable (full text + score). */
export async function getSubDeliverable(subId: string, index: number): Promise<{ deliverable: string | null; score: number | null }> {
  try {
    const res = await fetch(`${API_URL}/api/sub-deliverable/${subId}/${index}`);
    if (!res.ok) return { deliverable: null, score: null };
    return res.json();
  } catch {
    return { deliverable: null, score: null };
  }
}

/** Fetch a single recurring-market plan deliverable (full text + score). */
export async function getPlanDeliverable(planId: string, index: number): Promise<{ deliverable: string | null; score: number | null }> {
  try {
    const res = await fetch(`${API_URL}/api/recurring-deliverable/${planId}/${index}`);
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
export async function uploadAsset(id: string, dataUri: string): Promise<void> {
  try {
    await fetch(`${API_URL}/api/asset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, dataUri }),
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
): Promise<void> {
  try {
    await fetch(`${API_URL}/api/agent-meta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, ...meta }),
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
export async function getDeliverable(taskId: string, token: ViewToken): Promise<{ deliverable: string | null }> {
  const qs = new URLSearchParams({ viewer: token.viewer, expiry: String(token.expiry), signature: token.signature });
  const res = await fetch(`${API_URL}/api/deliverable/${taskId}?${qs}`);
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
 * Trigger verification: backend scores the work, signs, and calls
 * VerifierBridge.submitVerification - which releases USDC or slashes the stake.
 */
export async function verifyTask(taskId: string): Promise<VerifyResult> {
  const res = await fetch(`${API_URL}/api/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Verification failed");
  return res.json();
}
