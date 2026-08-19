/**
 * Resolves which backend serves a given network.
 *
 * Arc and BOT Chain run as separate runtime services (separate indexes, separate
 * signers, separate agent-wallet models), so the base URL belongs to the network
 * config rather than being a single global constant.
 */
const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** `VITE_API_URL_<KEY>` (one network) > `VITE_API_URL` (all networks, used by the
 *  local preview where a single process serves both) > the deployed default. */
export function apiBase(key: string, deployed: string): string {
  return ENV[`VITE_API_URL_${key}`] || ENV.VITE_API_URL || deployed;
}
