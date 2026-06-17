/**
 * Client for the Polaris verifier backend (backend/server.js).
 *
 * The backend holds the trusted verifier signer key, runs Claude scoring, and
 * relays the signed verdict to VerifierBridge.sol. The frontend never sees the
 * signer key. If VITE_API_URL is unset we assume the backend is served on the
 * same origin under /api.
 */
const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};
const API_URL = ENV.VITE_API_URL || "";

export type VerifyResult = {
  score: number;
  passed: boolean;
  reasoning: string;
  txHash?: string;
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

/** Fetch a stored deliverable (if any) for a task. */
export async function getDeliverable(taskId: string): Promise<{ deliverable: string | null }> {
  const res = await fetch(`${API_URL}/api/deliverable/${taskId}`);
  if (!res.ok) return { deliverable: null };
  return res.json();
}

/**
 * Trigger verification: backend scores with Claude, signs, and calls
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
