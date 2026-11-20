import { pgPoolActiveConnections, pgPoolIdleConnections, pgPoolWaitingQueries, setGauge } from "../indexer/metrics";

export interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  on(event: string, listener: (...args: any[]) => void): void;
}

export const SLOW_ACQUIRE_THRESHOLD_MS = 200;

/**
 * Connection pool tuning for high event burst loads (issue #217).
 * min 5 / max 30 connections, 5000ms statement timeout, 10000ms idle timeout.
 */
export const POOL_MIN_CONNECTIONS = 5;
export const POOL_MAX_CONNECTIONS = 30;
export const POOL_STATEMENT_TIMEOUT_MS = 5000;
export const POOL_IDLE_TIMEOUT_MS = 10000;

export interface PoolConfigLike {
  min?: number;
  max?: number;
  idleTimeoutMillis?: number;
  statement_timeout?: number;
  query_timeout?: number;
  [key: string]: unknown;
}

/**
 * Returns the pg-pool configuration tuned for burst event loads.
 */
export function getTunedPoolConfig(): PoolConfigLike {
  return {
    min: POOL_MIN_CONNECTIONS,
    max: POOL_MAX_CONNECTIONS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    query_timeout: POOL_STATEMENT_TIMEOUT_MS,
  };
}

/**
 * Instruments a pg-pool instance to track active, idle, and waiting queries in Prometheus telemetry.
 */
export function instrumentPool(pool: PoolLike): void {
  const updateMetrics = () => {
    setGauge(pgPoolActiveConnections, Math.max(0, pool.totalCount - pool.idleCount));
    setGauge(pgPoolIdleConnections, pool.idleCount);
    setGauge(pgPoolWaitingQueries, pool.waitingCount);
  };

  pool.on("acquire", () => {
    updateMetrics();
  });

  pool.on("release", () => {
    updateMetrics();
  });

  pool.on("error", (err: Error) => {
    console.error("[pg-pool] Unexpected error on idle client", err);
  });

  updateMetrics();
}

/**
 * Logs a warning if query connection acquisition wait time exceeds 200ms.
 */
export function logSlowAcquire(durationMs: number): void {
  if (durationMs > SLOW_ACQUIRE_THRESHOLD_MS) {
    console.warn(`[WARN] Database connection pool wait time exceeded 200ms: ${durationMs}ms`);
  }
}

/**
 * Detects transient pool saturation errors (e.g. pool exhausted / connection timeout)
 * so callers can retry with backoff instead of failing the event.
 */
export function isPoolSaturationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = String((err as { message?: unknown }).message ?? "").toLowerCase();
  const code = String((err as { code?: unknown }).code ?? "");
  return (
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("pool is draining") ||
    message.includes("connection terminated") ||
    message.includes("too many clients") ||
    code === "53300"
  );
}

/**
 * Runs a pool-backed operation with strict try/finally release semantics and
 * bounded retry/backoff on transient pool saturation.
 */
export async function withPooledConnection<T>(
  pool: { connect(): Promise<{ release(err?: Error | boolean): void }> },
  fn: (client: { release(err?: Error | boolean): void }) => Promise<T>,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;

  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    let client: { release(err?: Error | boolean): void } | undefined;
    try {
      client = await pool.connect();
      logSlowAcquire(Date.now() - startedAt);
      return await fn(client);
    } catch (err) {
      if (attempt < retries && isPoolSaturationError(err)) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[pg-pool] Saturated, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    } finally {
      if (client) client.release();
    }
  }
}
