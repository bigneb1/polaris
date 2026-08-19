/**
 * Resolves which backend serves a given network.
 *
 * Arc and BOT Chain run as separate runtime services (separate indexes, separate
 * signers, separate agent-wallet models), so the base URL belongs to the network
 * config rather than being a single global constant.
 */
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * `VITE_API_URL_<KEY>` (one network) > `VITE_API_URL` (ALL networks) > the deployed
 * default for this network.
 *
 * The middle rung is a footgun in production and deliberately documented as such in
 * VERCEL_ENV.md: it overrides every network's own correct default, so setting it on a
 * deployment where Arc and BOT Chain run as separate services sends BOT Chain traffic
 * to the Arc runtime, which refuses it with a 409 while Arc keeps working. It is kept
 * only because local development runs ONE process that serves both networks, which is
 * exactly the case where a single global base is right.
 */
export function apiBase(key: string, deployed: string): string {
  return ENV[`VITE_API_URL_${key}`] || ENV.VITE_API_URL || deployed;
}
