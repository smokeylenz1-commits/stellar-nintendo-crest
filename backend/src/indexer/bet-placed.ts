/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * Idempotency (#220): every event carries a deterministic `eventHash` derived from
 * `(ledger_sequence, tx_hash, event_index)`. The `events` and `bets` tables store it under a
 * UNIQUE constraint and inserts use `ON CONFLICT DO NOTHING`, so restarting the indexer during a
 * partially processed ledger cannot create duplicate bet rows or inflate pool totals.
 */

export interface BetPlacedEvent {
  ledgerSequence: number;
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
  eventHash: string;
  ledgerSequence: number;
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
  /** Records the raw event; returns `false` when the event hash already exists. */
  insertEvent(eventHash: string, ledgerSequence: number, txHash: string, eventIndex: number): Promise<boolean>;
  findBet(eventHash: string): Promise<BetRow | undefined>;
  /** Inserts the bet; returns `false` when the event hash already exists. */
  insertBet(row: BetRow): Promise<boolean>;
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
}

/**
 * Deterministic event hash from `(ledger_sequence, tx_hash, event_index)`.
 *
 * The same event always yields the same hash, so a replayed event collides on the UNIQUE
 * constraint and is skipped instead of being applied twice.
 */
export function computeEventHash(ledgerSequence: number, txHash: string, eventIndex: number): string {
  return `${ledgerSequence}:${txHash.toLowerCase()}:${eventIndex}`;
}

/**
 * Applies one BetPlaced event. Returns `false` when the event was already recorded.
 */
export async function handleBetPlaced(store: BetStore, event: BetPlacedEvent): Promise<boolean> {
  const eventHash = computeEventHash(event.ledgerSequence, event.txHash, event.eventIndex);

  return store.transaction(async (tx) => {
    const eventInserted = await tx.insertEvent(
      eventHash,
      event.ledgerSequence,
      event.txHash,
      event.eventIndex,
    );
    if (!eventInserted) {
      return false;
    }

    const existing = await tx.findBet(eventHash);
    if (existing) {
      return false;
    }

    const betInserted = await tx.insertBet({
      eventHash,
      ledgerSequence: event.ledgerSequence,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      marketId: event.marketId,
      bettor: event.bettor,
      isYes: event.isYes,
      grossAmount: event.grossAmount,
      netAmount: event.netAmount,
      timestamp: event.timestamp,
    });
    if (!betInserted) {
      return false;
    }

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
