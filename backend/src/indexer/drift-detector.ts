/**
 * Chain-to-database drift detector (#27).
 *
 * Samples active markets, reads their totals from the contract, and compares them with the
 * cached `total_yes` and `total_no` in the database. Any mismatch is reported as a structured
 * alert with a metric count. The sample is random, so each run checks a different set of
 * markets over time.
 */

export const SAMPLE_SIZE = 10;

export interface MarketTotalsSnapshot {
  marketId: number;
  totalYes: bigint;
  totalNo: bigint;
}

export interface DriftDeps {
  activeMarketIds(): Promise<number[]>;
  dbTotals(marketId: number): Promise<MarketTotalsSnapshot | undefined>;
  chainTotals(marketId: number): Promise<MarketTotalsSnapshot>;
  alert(fields: Record<string, unknown>, message: string): void;
  incDrift(by: number): void;
  random?: () => number;
}

export interface DriftFinding {
  marketId: number;
  dbYes: bigint;
  chainYes: bigint;
  dbNo: bigint;
  chainNo: bigint;
}

/** Picks up to `n` distinct items at random without replacement. */
export function sample<T>(items: T[], n: number, random: () => number = Math.random): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length > 0 && out.length < n) {
    const i = Math.floor(random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/**
 * One audit pass. Returns every market whose database totals differ from the chain.
 */
export async function runDriftAudit(deps: DriftDeps): Promise<DriftFinding[]> {
  const ids = sample(await deps.activeMarketIds(), SAMPLE_SIZE, deps.random);
  const findings: DriftFinding[] = [];

  for (const marketId of ids) {
    const db = await deps.dbTotals(marketId);
    const chain = await deps.chainTotals(marketId);
    if (!db) continue;
    if (db.totalYes !== chain.totalYes || db.totalNo !== chain.totalNo) {
      findings.push({
        marketId,
        dbYes: db.totalYes,
        chainYes: chain.totalYes,
        dbNo: db.totalNo,
        chainNo: chain.totalNo,
      });
    }
  }

  if (findings.length > 0) {
    deps.incDrift(findings.length);
    deps.alert(
      { event: "state_drift", markets: findings.map((f) => f.marketId) },
      `State drift detected in ${findings.length} sampled market(s)`,
    );
  }
  return findings;
}
