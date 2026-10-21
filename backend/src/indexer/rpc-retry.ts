/**
 * Full-jitter retry for Soroban RPC calls (#28).
 *
 * On a 429 or 503 the call is retried after `random(0, min(CAP, BASE * 2^attempt))`. Every client
 * therefore picks a different delay, which spreads the retries out and avoids a thundering herd.
 * Each attempt is logged with its context.
 */

export const BASE_DELAY_MS = 500;
export const CAP_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 503]);

/** Full jitter: a uniform delay between 0 and the capped exponential. */
export function fullJitterDelay(
  attempt: number,
  random: () => number = Math.random,
  base = BASE_DELAY_MS,
  cap = CAP_DELAY_MS,
): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export class RpcHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RpcRetryDeps {
  sleep(ms: number): Promise<void>;
  random?: () => number;
  log(fields: Record<string, unknown>, message: string): void;
  maxAttempts?: number;
}

/**
 * Calls `request` until it succeeds, a non-retryable error occurs, or attempts run out.
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
      const retryable = err instanceof RpcHttpError && RETRYABLE_STATUS.has(err.status);
      if (!retryable || attempt + 1 >= maxAttempts) {
        throw err;
      }
      const delay = fullJitterDelay(attempt, deps.random);
      deps.log(
        { event: "rpc_retry", call: label, attempt: attempt + 1, delayMs: delay, status: (err as RpcHttpError).status },
        "Soroban RPC returned a retryable status; retrying",
      );
      await deps.sleep(delay);
    }
  }
}
