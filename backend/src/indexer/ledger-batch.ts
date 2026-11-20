import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

/**
 * PostgreSQL connection pool for the indexer runner.
 *
 * Tuned for high event burst loads (hundreds of concurrent bet events):
 * - min 5 warm connections to absorb sudden bursts without handshake latency
 * - max 30 connections to bound server-side resource usage
 * - 5000ms statement timeout so runaway queries fail fast instead of
 *   holding a connection and starving the pool
 * - 10000ms idle timeout to reclaim connections after bursts subside
 */
export const pool = new Pool({
  min: 5,
  max: 30,
  idleTimeoutMillis: 10000,
  statement_timeout: 5000,
  query_timeout: 5000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

const MAX_POOL_RETRIES = 3;
const POOL_RETRY_BASE_DELAY_MS = 100;

function isPoolSaturationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('too many clients already') ||
    message.includes('remaining connection slots are reserved') ||
    message.includes('Connection terminated')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a client from the pool, retrying with exponential backoff when the
 * pool is transiently saturated. Throws the last error if all retries fail.
 */
async function acquireClient(): Promise<PoolClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_POOL_RETRIES; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      lastError = err;
      if (!isPoolSaturationError(err) || attempt === MAX_POOL_RETRIES) {
        break;
      }
      const backoff = POOL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn('PostgreSQL pool saturated, retrying connection', {
        attempt: attempt + 1,
        backoffMs: backoff,
      });
      await delay(backoff);
    }
  }
  throw lastError;
}

/**
 * Run a unit of work against a pooled client with strict try/finally release
 * semantics so connections are never leaked, even when the callback throws.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await acquireClient();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export interface LedgerBatchEntry {
  eventId: string;
  tokenAddress: string;
  amount: string;
  ledger: number;
  timestamp: Date;
}

/**
 * Persist a batch of ledger entries in a single transaction.
 * Uses withClient so the connection is always released back to the pool.
 */
export async function persistLedgerBatch(entries: LedgerBatchEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await withClient(async (client) => {
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        await client.query(
          `INSERT INTO token_ledger (event_id, token_address, amount, ledger, timestamp)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id) DO NOTHING`,
          [entry.eventId, entry.tokenAddress, entry.amount, entry.ledger, entry.timestamp],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('Failed to roll back ledger batch transaction', {
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
      throw err;
    }
  });
}
