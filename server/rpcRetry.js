/**
 * Bounded retry for transient RPC failures.
 *
 * BOT Chain has exactly one public RPC per network, so `buildProvider`'s
 * `FallbackProvider` has nothing to fail over TO: it collapses to a single
 * `JsonRpcProvider` whose errors go straight to the caller. When `rpc.bohr.life`
 * started answering with intermittent nginx 503s, every one of those reached the
 * swarm tick and aborted it — the testnet runtime went ten hours without placing a
 * single bid, and a task sat OPEN through its whole auction window because of it.
 *
 * Failover is the right fix when a second endpoint exists. Retry is the fix when
 * one does not, and the two compose: this wraps each sub-provider, so a multi-URL
 * network retries an endpoint briefly before failing over to the next.
 */

/** Errors that must NEVER be retried: the chain has answered, and it said no. */
const FATAL_CODES = new Set([
  "CALL_EXCEPTION", // a revert — replaying it just reverts again
  "INSUFFICIENT_FUNDS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "TRANSACTION_REPLACED",
  "UNCONFIGURED_NAME",
  "ACTION_REJECTED",
  "INVALID_ARGUMENT",
  "NUMERIC_FAULT",
  "BAD_DATA", // a decode failure, not a delivery failure
]);

/** Error codes that mean "the request never got an answer", i.e. worth repeating. */
const TRANSIENT_CODES = new Set(["SERVER_ERROR", "TIMEOUT", "NETWORK_ERROR"]);

/**
 * Never replayed even when transient. A signed transaction that may already be in
 * the mempool must not be re-sent blind: the retry would surface as "already
 * known" or a nonce error and mask the original failure. Callers (the swarm tick,
 * the reaper) already retry sends on their own schedule, with fresh nonces.
 */
const NON_RETRYABLE_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction"]);

/** The HTTP statuses worth repeating: server-side faults and rate limits. */
function statusIsTransient(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Is this failure worth repeating verbatim?
 *
 * Conservative by design: anything we cannot positively identify as transient is
 * treated as final, so a revert or a bad argument fails fast instead of being
 * retried three times and reported 800ms late.
 */
export function isTransientRpcError(err) {
  if (!err) return false;
  const code = err.code;
  if (FATAL_CODES.has(code)) return false;

  // ethers puts the HTTP result in `info` — the status is the most reliable
  // signal we get, so when there is one it decides on its own.
  const raw = err.info?.responseStatus ?? err.status ?? err.info?.status;
  const status = typeof raw === "string" ? parseInt(raw, 10) : raw;
  if (Number.isFinite(status)) return statusIsTransient(status);

  if (TRANSIENT_CODES.has(code)) return true;

  // Rate limiting is reported a dozen different ways by a dozen different
  // providers, and almost never with a code we can switch on.
  const msg = String(err.shortMessage || err.message || "");
  return /rate.?limit|too many requests|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|503|502|504/i.test(msg);
}

/**
 * Wrap a provider's `send` so transient failures are repeated with exponential
 * backoff. Mutates and returns the provider — ethers builds requests through
 * `send`, so every read (and every contract call) inherits this for free.
 *
 * `sleep` is injectable so tests can assert the backoff without waiting for it.
 */
export function withRpcRetry(provider, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts ?? process.env.RPC_RETRY_ATTEMPTS ?? 3));
  const baseDelayMs = Math.max(0, Number(opts.baseDelayMs ?? process.env.RPC_RETRY_BASE_MS ?? 200));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onRetry = opts.onRetry;

  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    if (NON_RETRYABLE_METHODS.has(method)) return send(method, params);
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(method, params);
      } catch (err) {
        if (attempt >= attempts || !isTransientRpcError(err)) throw err;
        onRetry?.({ method, attempt, error: err });
        // 200ms, 600ms, 1800ms … — long enough for a load balancer to shed a
        // bad upstream, short enough that a 12s tick still completes.
        await sleep(baseDelayMs * 3 ** (attempt - 1));
      }
    }
  };
  return provider;
}
