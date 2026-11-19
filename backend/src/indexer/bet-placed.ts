/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * The `bets` table is declaratively partitioned by `placed_at` on calendar-quarter RANGE
 * boundaries (#252). Partitioning is transparent to this handler: inserts route to the correct
 * quarterly partition automatically and reads against `bets` are unchanged. The helpers below
 * derive the quarter boundaries used by the partition-management routine so the indexer and the
 * migration/runbook agree on the same calendar-quarter scheme.
 *
 * Leaderboard point accumulation (#254) is applied through `applyLeaderboardPoints`, which locks
 * and updates rows in deterministic `user_address ASC` order and uses atomic
 * `points = points + $1` increments. Ordering the locks the same way in every transaction is
 * what prevents PostgreSQL deadlocks when concurrent bet settlements touch overlapping rows.
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

/** One leaderboard point delta for a user address. */
export interface LeaderboardPointDelta {
  userAddress: string;
  points: bigint;
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
  /**
   * Atomically adds `points` to `userAddress`'s leaderboard score
   * (`UPDATE ... SET points = points + $1`), inserting the row when absent (UPSERT).
   */
  incrementLeaderboardPoints(userAddress: string, points: bigint): Promise<void>;
}

/**
 * Calendar-quarter partition descriptor for the `bets` table (#252).
 *
 * `name` is the child partition table name (e.g. `bets_2026_q1`) and `[start, end)` is the
 * half-open `placed_at` range it covers, matching PostgreSQL RANGE partition bounds.
 */
export interface BetPartition {
  name: string;
  start: Date;
  end: Date;
}

/**
 * Returns the calendar-quarter partition that covers `date`.
 *
 * Quarters are calendar-aligned: Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec. The
 * returned range is half-open (`start` inclusive, `end` exclusive) so adjacent partitions never
 * overlap, which is required for PostgreSQL RANGE partitioning.
 */
export function betPartitionFor(date: Date): BetPartition {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0, 0));
  return { name: `bets_${year}_q${quarter}`, start, end };
}

/**
 * Returns the next `count` calendar-quarter partitions starting at the quarter containing
 * `from`. Used by the partition-management routine to pre-provision upcoming quarters so inserts
 * never fail on a missing partition.
 */
export function upcomingBetPartitions(from: Date, count: number): BetPartition[] {
  const partitions: BetPartition[] = [];
  let cursor = betPartitionFor(from).start;
  for (let i = 0; i < count; i += 1) {
    const partition = betPartitionFor(cursor);
    partitions.push(partition);
    cursor = partition.end;
  }
  return partitions;
}

/**
 * Applies leaderboard point deltas inside an open transaction (#254).
 *
 * Deltas are sorted by `userAddress ASC` before any row is locked/updated so every concurrent
 * transaction acquires row locks in the same global order, which eliminates the classic
 * PostgreSQL deadlock caused by two transactions updating the same rows in opposite orders.
 * Each row is then incremented atomically (`points = points + $1`) rather than read-modify-write.
 */
export async function applyLeaderboardPoints(
  tx: BetStoreTx,
  deltas: readonly LeaderboardPointDelta[],
): Promise<void> {
  const ordered = [...deltas].sort((a, b) =>
    a.userAddress < b.userAddress ? -1 : a.userAddress > b.userAddress ? 1 : 0,
  );
  for (const delta of ordered) {
    if (delta.points === 0n) {
      continue;
    }
    await tx.incrementLeaderboardPoints(delta.userAddress, delta.points);
  }
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

    await applyLeaderboardPoints(tx, [
      { userAddress: event.bettor, points: event.netAmount },
    ]);

    return true;
  });
}
