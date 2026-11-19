/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * Referential integrity (#249): `bets.market_id` is enforced by a foreign key to `markets.id`
 * with `ON DELETE RESTRICT`, so a bet can never reference a missing market. The handler checks
 * the market exists before inserting and surfaces a typed error instead of letting the insert
 * fail on the constraint, keeping historical/orphan events from creating orphan rows.
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
  /** Returns whether the referenced market exists; guards the `bets.market_id` FK. */
  marketExists(marketId: number): Promise<boolean>;
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
}

/** Raised when a BetPlaced event references a market that does not exist. */
export class UnknownMarketError extends Error {
  constructor(public readonly marketId: number) {
    super(`BetPlaced references unknown market ${marketId}`);
    this.name = 'UnknownMarketError';
  }
}

/**
 * Applies one BetPlaced event. Returns `false` when the event was already recorded.
 *
 * Throws {@link UnknownMarketError} when the market is missing, so the caller can skip the
 * event rather than violate the `bets.market_id` foreign key.
 */
export async function handleBetPlaced(store: BetStore, event: BetPlacedEvent): Promise<boolean> {
  return store.transaction(async (tx) => {
    const existing = await tx.findBet(event.txHash, event.eventIndex);
    if (existing) {
      return false;
    }

    if (!(await tx.marketExists(event.marketId))) {
      throw new UnknownMarketError(event.marketId);
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
