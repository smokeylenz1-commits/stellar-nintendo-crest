/**
 * Jittered exponential backoff retry for Soroban RPC calls (#208).
 *
 * On a 429 or 503, or on a connection error, the call is retried after
 * `min(MAX, BASE * FACTOR^attempt)` scaled by a ±JITTER band. Each attempt is
 * logged with its context and reported to metrics so retries and sleep time
 * are observable. Once a healthy response returns, the caller resumes its
 * normal polling interval.
 */

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 10_000;
export const BACKOFF_FACTOR = 1.5;
export const JITTER_RATIO = 0.2;
const RETRYABLE_STATUS = new Set([429, 503]);

/**
 * Jittered exponential backoff: `min(MAX, BASE * FACTOR^attempt)` with a
 * ±`JITTER_RATIO` band applied so concurrent clients spread their retries.
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  base = BASE_DELAY_MS,
  max = MAX_DELAY_MS,
  factor = BACKOFF_FACTOR,
  jitter = JITTER_RATIO,
): number {
  const ceiling = Math.min(max, base * factor ** attempt);
  const spread = ceiling * jitter;
  const offset = (random() * 2 - 1) * spread;
  return Math.max(0, Math.floor(ceiling + offset));
}

export class RpcHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Connection-level failures (drops, resets, timeouts) that should be retried. */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof RpcHttpError) return false;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND"].includes(code)) {
    return true;
  }
  return /socket hang up|network|connection|timeout|fetch failed/i.test(err.message);
}

export interface RpcRetryMetrics {
  recordRetry(label: string, attempt: number, delayMs: number): void;
  recordBackoffSleep(label: string, delayMs: number): void;
}

export interface RpcRetryDeps {
  sleep(ms: number): Promise<void>;
  random?: () => number;
  log(fields: Record<string, unknown>, message: string): void;
  metrics?: RpcRetryMetrics;
  maxAttempts?: number;
}

/**
 * Calls `request` until it succeeds, a non-retryable error occurs, or attempts run out.
 * Retryable statuses (429/503) and connection errors trigger backoff instead of throwing.
 */
export async function withRpcRetry<T>(
  label: string,
  request: () => Promise<T>,
  deps: RpcRetryDeps,
): Promise<T> {
  const maxAttempts = deps.maxAttempts ?? 6;
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      const retryable =
        (err instanceof RpcHttpError && RETRYABLE_STATUS.has(err.status)) || isConnectionError(err);
      if (!retryable || attempt + 1 >= maxAttempts) {
        throw err;
      }
      const delay = backoffDelay(attempt, deps.random);
      const status = err instanceof RpcHttpError ? err.status : undefined;
      deps.metrics?.recordRetry(label, attempt + 1, delay);
      deps.log(
        { event: "rpc_retry", call: label, attempt: attempt + 1, delayMs: delay, status },
        "Soroban RPC call failed; backing off before retry",
      );
      deps.metrics?.recordBackoffSleep(label, delay);
      await deps.sleep(delay);
    }
  }
}
