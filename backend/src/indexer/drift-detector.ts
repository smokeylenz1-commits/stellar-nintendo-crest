/**
 * Chain-to-database drift detector (#27).
 *
 * Samples active markets, reads their totals from the contract, and compares them with the
 * cached `total_yes` and `total_no` in the database. Any mismatch is reported as a structured
 * alert with a metric count. The sample is random, so each run checks a different set of
 * markets over time.
 *
 * Also hosts ledger reorg detection and rollback reconciliation (#209): incoming ledger
 * headers are compared against the stored checkpoint, and on a fork the database is rolled
 * back to the last common ancestor before canonical ledgers are re-ingested.
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

/** A stored ledger checkpoint: sequence number plus the hash of its parent ledger. */
export interface LedgerCheckpoint {
  sequence: number;
  parentHash: string;
}

/** An incoming ledger header as observed from the network. */
export interface LedgerHeader {
  sequence: number;
  hash: string;
  parentHash: string;
}

export interface ReorgDeps {
  /** Returns the stored checkpoint for a ledger sequence, if any. */
  getCheckpoint(sequence: number): Promise<LedgerCheckpoint | undefined>;
  /** Returns the stored hash for a ledger sequence, if any. */
  getStoredHash(sequence: number): Promise<string | undefined>;
  /** Rolls back all database mutations at or above `sequence`. */
  rollbackTo(sequence: number): Promise<void>;
  /** Re-ingests a canonical ledger header into the database. */
  ingest(header: LedgerHeader): Promise<void>;
  alert(fields: Record<string, unknown>, message: string): void;
  incReorg(by: number): void;
}

export interface ReorgResult {
  reorg: boolean;
  /** Last common ancestor ledger sequence, when a reorg was detected. */
  forkPoint?: number;
  /** Ledgers re-ingested after rollback. */
  reingested: number;
}

/**
 * Detects whether an incoming ledger header forks from the stored checkpoint.
 *
 * A mismatch occurs when the stored hash for the incoming sequence differs from the
 * incoming hash, or when the incoming parent hash does not match the stored hash of the
 * previous ledger.
 */
export async function detectReorg(
  header: LedgerHeader,
  deps: Pick<ReorgDeps, "getCheckpoint" | "getStoredHash">,
): Promise<boolean> {
  const checkpoint = await deps.getCheckpoint(header.sequence);
  if (checkpoint) {
    if (checkpoint.parentHash !== header.parentHash) return true;
  }

  const storedHash = await deps.getStoredHash(header.sequence);
  if (storedHash && storedHash !== header.hash) return true;

  const parentStored = await deps.getStoredHash(header.sequence - 1);
  if (parentStored && parentStored !== header.parentHash) return true;

  return false;
}

/**
 * Walks backwards from `fromSequence` to find the last common ancestor ledger whose stored
 * hash matches the canonical chain. Returns the fork point sequence (the ancestor), or
 * `undefined` if no common ancestor is found within `maxDepth`.
 */
export async function findForkPoint(
  fromSequence: number,
  canonicalHashes: Map<number, string>,
  deps: Pick<ReorgDeps, "getStoredHash">,
  maxDepth = 100,
): Promise<number | undefined> {
  for (let seq = fromSequence; seq > fromSequence - maxDepth && seq >= 0; seq--) {
    const canonical = canonicalHashes.get(seq);
    if (canonical === undefined) continue;
    const stored = await deps.getStoredHash(seq);
    if (stored !== undefined && stored === canonical) return seq;
  }
  return undefined;
}

/**
 * Handles an incoming ledger header: detects forks, rolls back to the last common ancestor,
 * and re-ingests the canonical ledgers supplied in `canonicalLedgers`.
 */
export async function reconcileLedger(
  header: LedgerHeader,
  canonicalLedgers: LedgerHeader[],
  deps: ReorgDeps,
): Promise<ReorgResult> {
  const forked = await detectReorg(header, deps);
  if (!forked) {
    await deps.ingest(header);
    return { reorg: false, reingested: 1 };
  }

  const canonicalHashes = new Map<number, string>();
  for (const ledger of canonicalLedgers) canonicalHashes.set(ledger.sequence, ledger.hash);

  const forkPoint = await findForkPoint(header.sequence - 1, canonicalHashes, deps);
  if (forkPoint === undefined) {
    deps.alert(
      { event: "reorg_unresolved", sequence: header.sequence },
      `Reorg detected at ledger ${header.sequence} but no common ancestor found`,
    );
    return { reorg: true, reingested: 0 };
  }

  deps.incReorg(1);
  deps.alert(
    { event: "reorg_detected", sequence: header.sequence, forkPoint },
    `Reorg detected at ledger ${header.sequence}; rolling back to ${forkPoint}`,
  );

  await deps.rollbackTo(forkPoint + 1);

  let reingested = 0;
  for (const ledger of canonicalLedgers) {
    if (ledger.sequence <= forkPoint) continue;
    await deps.ingest(ledger);
    reingested++;
  }

  return { reorg: true, forkPoint, reingested };
}
