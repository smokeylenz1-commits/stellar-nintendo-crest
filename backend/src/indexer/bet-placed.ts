/**
 * BetPlaced handler (#20).
 *
 * Turns a `BetPlaced` contract event into one bet row and the matching market totals, in a
 * single transaction, and is idempotent on `(tx_hash, event_index)` so a replayed event is
 * applied once. The store is an interface so the handler runs against PostgreSQL in the indexer
 * and against an in-memory store in tests.
 *
 * Market stats (odds, implied probabilities, total pool sizes) are cached in a Redis hash per
 * market (#241). The cache is updated incrementally after the transaction commits and is
 * invalidated so the next read repopulates it from the database.
 *
 * Historical user P&L and ROI analytics (#242) are aggregated from the recorded bets, payouts,
 * and IPREDICT rewards so the API can serve `/api/users/:address/analytics`.
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
  getMarketTotals(marketId: number): Promise<MarketTotals | undefined>;
  setMarketTotals(totals: MarketTotals): Promise<void>;
}

/**
 * Minimal Redis surface used to cache market stats. Kept as an interface so the handler can run
 * against ioredis in production and an in-memory fake in tests.
 */
export interface MarketStatsCache {
  /** Returns the cached hash for a market, or `undefined` when the cache is cold. */
  getMarketStats(marketId: number): Promise<MarketTotals | undefined>;
  /** Writes the full stats hash for a market. */
  setMarketStats(totals: MarketTotals): Promise<void>;
  /** Drops the cached stats for a market so the next read falls back to the database. */
  invalidateMarketStats(marketId: number): Promise<void>;
}

/**
 * Applies one BetPlaced event. Returns `false` when the event was already recorded.
 *
 * When a `cache` is supplied, the market's cached stats are invalidated after the transaction
 * commits so the next odds query repopulates from the database instead of serving stale odds.
 */
export async function handleBetPlaced(
  store: BetStore,
  event: BetPlacedEvent,
  cache?: MarketStatsCache,
): Promise<boolean> {
  const applied = await store.transaction(async (tx) => {
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

  if (applied && cache) {
    await cache.invalidateMarketStats(event.marketId);
  }

  return applied;
}

/**
 * Reads market stats from the cache, falling back to the database when the cache is cold and
 * repopulating it so subsequent odds queries are served from Redis.
 */
export async function getMarketStats(
  store: BetStore,
  cache: MarketStatsCache,
  marketId: number,
): Promise<MarketTotals | undefined> {
  const cached = await cache.getMarketStats(marketId);
  if (cached) {
    return cached;
  }

  const totals = await store.transaction((tx) => tx.getMarketTotals(marketId));
  if (totals) {
    await cache.setMarketStats(totals);
  }
  return totals;
}

/** One resolved bet outcome used to compute win/loss counts and P&L. */
export interface ResolvedBet {
  bettor: string;
  /** Net amount staked (after fees), in the smallest token unit. */
  netAmount: bigint;
  /** Payout credited to the bettor when the market resolved in their favour, else `0n`. */
  payout: bigint;
  /** Whether the bet won. */
  won: boolean;
  timestamp: Date;
}

/** A single point in the cumulative P&L time series. */
export interface PnlDataPoint {
  /** ISO date (UTC, `YYYY-MM-DD`) the point covers. */
  date: string;
  /** Cumulative net profit/loss up to and including this day, in the smallest token unit. */
  cumulativePnl: bigint;
}

/** Aggregated historical performance for one user. */
export interface UserAnalytics {
  address: string;
  totalBets: number;
  winCount: number;
  lossCount: number;
  /** Win rate as a percentage (0–100), rounded to two decimals. */
  winRate: number;
  /** Total amount staked across all bets, in the smallest token unit. */
  totalVolume: bigint;
  /** Net profit/loss across all resolved bets, in the smallest token unit. */
  totalPnl: bigint;
  /** Return on investment as a percentage, rounded to two decimals. */
  roi: number;
  /** Cumulative P&L over the trailing 30 days, one point per day, for charting. */
  pnlSeries: PnlDataPoint[];
  /** Referral commissions earned by the user, in the smallest token unit. */
  referralCommissions: bigint;
  /** Current token balances held by the user, keyed by token symbol. */
  tokenBalances: Record<string, bigint>;
}

/** Source of the raw data needed to build a user's analytics. */
export interface UserAnalyticsStore {
  /** All resolved bets for the user, ordered by timestamp ascending. */
  getResolvedBets(address: string): Promise<ResolvedBet[]>;
  /** Total referral commissions earned by the user, in the smallest token unit. */
  getReferralCommissions(address: string): Promise<bigint>;
  /** Current token balances held by the user, keyed by token symbol. */
  getTokenBalances(address: string): Promise<Record<string, bigint>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PNL_WINDOW_DAYS = 30;

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the trailing 30-day cumulative P&L series. Each day's point carries the running total
 * of net P&L (payout minus stake) for every resolved bet up to and including that day, so the
 * series can be plotted directly as a cumulative growth curve.
 */
function buildPnlSeries(bets: ResolvedBet[], now: Date): PnlDataPoint[] {
  const windowStart = new Date(now.getTime() - (PNL_WINDOW_DAYS - 1) * DAY_MS);
  const startKey = toUtcDateKey(windowStart);

  // Running P&L from bets before the window seeds the first point so the curve is continuous.
  let running = 0n;
  const dailyPnl = new Map<string, bigint>();
  for (const bet of bets) {
    const pnl = bet.payout - bet.netAmount;
    const key = toUtcDateKey(bet.timestamp);
    if (key < startKey) {
      running += pnl;
    } else {
      dailyPnl.set(key, (dailyPnl.get(key) ?? 0n) + pnl);
    }
  }

  const series: PnlDataPoint[] = [];
  for (let i = 0; i < PNL_WINDOW_DAYS; i += 1) {
    const day = new Date(windowStart.getTime() + i * DAY_MS);
    const key = toUtcDateKey(day);
    running += dailyPnl.get(key) ?? 0n;
    series.push({ date: key, cumulativePnl: running });
  }
  return series;
}

/**
 * Aggregates a user's historical bets, payouts, and IPREDICT rewards into total P&L, win rate,
 * ROI, a 30-day cumulative P&L series, referral commissions, and token balances (#242).
 */
export async function getUserAnalytics(
  store: UserAnalyticsStore,
  address: string,
  now: Date = new Date(),
): Promise<UserAnalytics> {
  const [bets, referralCommissions, tokenBalances] = await Promise.all([
    store.getResolvedBets(address),
    store.getReferralCommissions(address),
    store.getTokenBalances(address),
  ]);

  let winCount = 0;
  let lossCount = 0;
  let totalVolume = 0n;
  let totalPnl = 0n;
  for (const bet of bets) {
    totalVolume += bet.netAmount;
    totalPnl += bet.payout - bet.netAmount;
    if (bet.won) {
      winCount += 1;
    } else {
      lossCount += 1;
    }
  }

  const resolved = winCount + lossCount;
  const winRate = resolved === 0 ? 0 : roundPercent((winCount / resolved) * 100);
  const roi = totalVolume === 0n ? 0 : roundPercent((Number(totalPnl) / Number(totalVolume)) * 100);

  return {
    address,
    totalBets: bets.length,
    winCount,
    lossCount,
    winRate,
    totalVolume,
    totalPnl,
    roi,
    pnlSeries: buildPnlSeries(bets, now),
    referralCommissions,
    tokenBalances,
  };
}
