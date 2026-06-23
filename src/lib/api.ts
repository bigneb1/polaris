/**
 * Client for the Polaris verifier backend (backend/server.js).
 *
 * The backend holds the trusted verifier signer key, runs the scoring, and
 * relays the signed verdict to VerifierBridge.sol. The frontend never sees the
 * signer key. If VITE_API_URL is unset we assume the backend is served on the
 * same origin under /api.
 */
const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const API_URL = ENV.VITE_API_URL || "https://polaris-agent-runtime-production.up.railway.app";

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

/** Store a deliverable for a task (kept off-chain; only its score goes onchain). */
export async function submitDeliverable(taskId: string, agentWallet: string, deliverable: string) {
  const res = await fetch(`${API_URL}/api/deliverable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, agentWallet, deliverable }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to store deliverable");
  return res.json();
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

/** Fetch a stored deliverable (if any) for a task. */
export async function getDeliverable(taskId: string): Promise<{ deliverable: string | null }> {
  const res = await fetch(`${API_URL}/api/deliverable/${taskId}`);
  if (!res.ok) return { deliverable: null };
  return res.json();
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
