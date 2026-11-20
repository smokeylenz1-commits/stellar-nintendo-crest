/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 */

export interface BetPlacedEvent {
  txHash: string;
  eventIndex: number;
  marketId: number;
  bettor: string;
  isYes: boolean;
  grossAmount: bigint;
  netAmount: bigint;
  timestamp: Date;
  /** Contract method invoked by the transaction (e.g. `place_bet`). */
  contractMethod?: string;
  /** Resource telemetry parsed from the transaction envelope result (#219). */
  telemetry?: TxTelemetry;
}

/**
 * Per-transaction gas/resource telemetry (#219). Parsed from the transaction envelope result
 * and stored alongside the bet/market records so protocol developers can track gas trends.
 */
export interface TxTelemetry {
  cpuInstructions: bigint;
  ramBytes: bigint;
  feeStroops: bigint;
}

export interface TxTelemetryRow extends TxTelemetry {
  txHash: string;
  eventIndex: number;
  contractMethod: string;
}

export interface BetRow {
  txHash: string;
  eventIndex: number;
  marketId: number;
  bettor: string;
  isYes: boolean;
  grossAmount: bigint;
  netAmount: bigint;
  timestamp: Date;
}

export interface MarketTotals {
  marketId: number;
  totalYes: bigint;
  totalNo: bigint;
  betCount: number;
}

export interface BetStore {
  /** Runs `work` in one transaction; every write in it commits or none does. */
  transaction<T>(work: (tx: BetStoreTx) => Promise<T>): Promise<T>;
}

export interface BetStoreTx {
  findBet(txHash: string, eventIndex: number): Promise<BetRow | undefined>;
  insertBet(row: BetRow): Promise<void>;
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
  /** Persists gas/resource telemetry for the transaction (#219). */
  insertTxTelemetry(row: TxTelemetryRow): Promise<void>;
}

/**
 * Pool tuning for the indexer runner (#217). Under burst loads hundreds of concurrent bet
 * events can exhaust the pool, so we cap concurrency, keep a warm floor of connections, and
 * bound how long a single statement may hold a connection.
 */
export const BET_POOL_CONFIG = {
  min: 5,
  max: 30,
  statementTimeoutMs: 5000,
  idleTimeoutMs: 10000,
} as const;

/**
 * Retry policy for transient pool saturation. When the pool is exhausted the driver rejects
 * with a pool-timeout error; we back off and retry rather than dropping the event.
 */
export const BET_POOL_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 25,
  maxDelayMs: 1000,
} as const;

function isPoolSaturationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === '53300') {
    return true;
  }
  return typeof message === 'string' && /pool|connection|timeout/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Applies one BetPlaced event. Returns `false` when the event was already recorded.
 *
 * The transaction is always released by the store's `transaction` implementation (strict
 * try/finally semantics live there); here we only add bounded retry/backoff so a transient
 * pool-saturation rejection is retried instead of losing the event.
 */
export async function handleBetPlaced(store: BetStore, event: BetPlacedEvent): Promise<boolean> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await store.transaction(async (tx) => {
        const existing = await tx.findBet(event.txHash, event.eventIndex);
        if (existing) {
          return false;
        }

        await tx.insertBet({
          txHash: event.txHash,
          eventIndex: event.eventIndex,
          marketId: event.marketId,
          bettor: event.bettor,
          isYes: event.isYes,
          grossAmount: event.grossAmount,
          netAmount: event.netAmount,
          timestamp: event.timestamp,
        });

        const current = (await tx.getMarketTotals(event.marketId)) ?? {
          marketId: event.marketId,
          totalYes: 0n,
          totalNo: 0n,
          betCount: 0,
        };
        await tx.setMarketTotals({
          marketId: event.marketId,
          totalYes: current.totalYes + (event.isYes ? event.netAmount : 0n),
          totalNo: current.totalNo + (event.isYes ? 0n : event.netAmount),
          betCount: current.betCount + 1,
        });

        if (event.telemetry) {
          await tx.insertTxTelemetry({
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            contractMethod: event.contractMethod ?? 'bet_placed',
            cpuInstructions: event.telemetry.cpuInstructions,
            ramBytes: event.telemetry.ramBytes,
            feeStroops: event.telemetry.feeStroops,
          });
        }

        return true;
      });
    } catch (err) {
      if (attempt >= BET_POOL_RETRY.maxAttempts || !isPoolSaturationError(err)) {
        throw err;
      }
      const backoff = Math.min(
        BET_POOL_RETRY.maxDelayMs,
        BET_POOL_RETRY.baseDelayMs * 2 ** (attempt - 1),
      );
      await delay(backoff);
    }
  }
}
