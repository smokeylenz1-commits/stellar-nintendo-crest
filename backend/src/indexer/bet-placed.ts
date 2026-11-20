/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * High-frequency events are grouped by `BetPlacedBuffer` (#210): events accumulate for up to
 * `flushIntervalMs` (or until `maxBatchSize` is reached) and are applied in one atomic
 * transaction. A failed flush keeps its events buffered so nothing is dropped.
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
  /** Inserts many bets in one `INSERT ... ON CONFLICT` statement. */
  insertBets(rows: BetRow[]): Promise<void>;
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
}

/**
 * Applies one BetPlaced event. Returns `false` when the event was already recorded.
 */
export async function handleBetPlaced(store: BetStore, event: BetPlacedEvent): Promise<boolean> {
  return store.transaction(async (tx) => {
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

    return true;
  });
}

/**
 * Applies a batch of BetPlaced events in one atomic transaction. Bets are inserted with a single
 * `INSERT ... ON CONFLICT` statement; market totals are folded per market and written once.
 * Returns the number of newly recorded events (replays are skipped).
 */
export async function handleBetPlacedBatch(
  store: BetStore,
  events: BetPlacedEvent[],
): Promise<number> {
  if (events.length === 0) {
    return 0;
  }

  return store.transaction(async (tx) => {
    const rows: BetRow[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const key = `${event.txHash}:${event.eventIndex}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (await tx.findBet(event.txHash, event.eventIndex)) {
        continue;
      }
      rows.push({
        txHash: event.txHash,
        eventIndex: event.eventIndex,
        marketId: event.marketId,
        bettor: event.bettor,
        isYes: event.isYes,
        grossAmount: event.grossAmount,
        netAmount: event.netAmount,
        timestamp: event.timestamp,
      });
    }

    if (rows.length === 0) {
      return 0;
    }

    await tx.insertBets(rows);

    const totals = new Map<number, MarketTotals>();
    for (const row of rows) {
      const current = totals.get(row.marketId) ??
        (await tx.getMarketTotals(row.marketId)) ?? {
          marketId: row.marketId,
          totalYes: 0n,
          totalNo: 0n,
          betCount: 0,
        };
      totals.set(row.marketId, {
        marketId: row.marketId,
        totalYes: current.totalYes + (row.isYes ? row.netAmount : 0n),
        totalNo: current.totalNo + (row.isYes ? 0n : row.netAmount),
        betCount: current.betCount + 1,
      });
    }
    for (const marketTotals of totals.values()) {
      await tx.setMarketTotals(marketTotals);
    }

    return rows.length;
  });
}

export interface BetPlacedBufferOptions {
  /** Max events per batch transaction. */
  maxBatchSize?: number;
  /** Max time an event waits before the buffer is flushed. */
  flushIntervalMs?: number;
}

/**
 * Buffer queue for high-frequency BetPlaced events (#210). Events accumulate and are flushed in
 * batches of up to `maxBatchSize` on a `flushIntervalMs` timer. A failed flush keeps its events
 * buffered so they are retried on the next flush instead of being dropped.
 */
export class BetPlacedBuffer {
  private readonly store: BetStore;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private queue: BetPlacedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(store: BetStore, options: BetPlacedBufferOptions = {}) {
    this.store = store;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
  }

  /** Queues an event, scheduling a flush and flushing immediately at `maxBatchSize`. */
  enqueue(event: BetPlacedEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  /** Number of events currently waiting to be flushed. */
  get pending(): number {
    return this.queue.length;
  }

  /** Flushes all buffered events in batches. Retains events if a batch fails. */
  async flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    this.clearTimer();
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      if (this.queue.length > 0) {
        this.schedule();
      }
    });
    return this.flushing;
  }

  /** Stops the timer and flushes any remaining events. */
  async close(): Promise<void> {
    this.clearTimer();
    await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.maxBatchSize);
      try {
        await handleBetPlacedBatch(this.store, batch);
      } catch (error) {
        // Keep the failed batch buffered so the next flush retries it; nothing is dropped.
        throw error;
      }
      this.queue.splice(0, batch.length);
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {
        // Errors surface on the next flush; the timer is rescheduled by `flush`.
      });
    }, this.flushIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
