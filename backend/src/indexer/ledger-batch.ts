/**
 * Batched writes for one ledger (#31).
 *
 * Instead of committing each event alone, the events of a ledger are written together: one
 * multi-row upsert per table, inside one transaction. If any write fails, the whole ledger
 * rolls back, so a ledger is never half applied.
 *
 * Reorg reconciliation (#209): incoming ledger headers are checked against the stored
 * checkpoint (sequence + parent hash). On a mismatch the database is rolled back to the last
 * common ancestor ledger and the canonical ledgers are re-ingested.
 */

export interface LedgerWrite {
  table: string;
  key: string;
  row: Record<string, unknown>;
}
export interface BatchStoreTx {
  /** Multi-row `INSERT ... ON CONFLICT DO UPDATE` for one table. */
  upsertMany(table: string, rows: Record<string, unknown>[]): Promise<void>;
}

export interface BatchStore {
  transaction<T>(work: (tx: BatchStoreTx) => Promise<T>): Promise<T>;
}

/**
 * Writes every event of one ledger in a single transaction. Rows are grouped per table, so each
 * table gets one multi-row statement instead of one statement per event.
 */
export async function flushLedgerBatch(store: BatchStore, writes: LedgerWrite[]): Promise<void> {
  if (writes.length === 0) return;

  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const w of writes) {
    const rows = byTable.get(w.table) ?? [];
    rows.push(w.row);
    byTable.set(w.table, rows);
  }

  await store.transaction(async (tx) => {
    for (const [table, rows] of byTable) {
      await tx.upsertMany(table, rows);
    }
  });
}

/** A ledger header as delivered by the ingestion stream. */
export interface LedgerHeader {
  sequence: number;
  /** Hash of this ledger. */
  hash: string;
  /** Hash of the previous ledger (parent). */
  parentHash: string;
}

/** The last ledger the indexer has durably applied. */
export interface LedgerCheckpoint {
  sequence: number;
  hash: string;
}

/** Persistence hooks needed to detect and reconcile a reorg. */
export interface ReorgStore {
  /** Returns the stored checkpoint, or `null` when nothing has been applied yet. */
  getCheckpoint(): Promise<LedgerCheckpoint | null>;
  /** Returns the stored hash for a ledger sequence, or `null` when it is not stored. */
  getLedgerHash(sequence: number): Promise<string | null>;
  /** Deletes every mutation applied at or above `sequence` (inclusive). */
  rollbackTo(sequence: number): Promise<void>;
  /** Persists the new checkpoint after a ledger has been applied. */
  setCheckpoint(checkpoint: LedgerCheckpoint): Promise<void>;
}

/**
 * Detects whether an incoming header forks from the stored chain.
 *
 * A header is a fork when its parent hash does not match the stored hash of the previous
 * ledger, or when it re-uses a sequence whose stored hash differs.
 */
export async function detectReorg(
  store: ReorgStore,
  header: LedgerHeader,
): Promise<boolean> {
  const checkpoint = await store.getCheckpoint();
  if (!checkpoint) return false;

  // Re-using an already applied sequence with a different hash is a fork.
  if (header.sequence <= checkpoint.sequence) {
    const stored = await store.getLedgerHash(header.sequence);
    return stored !== null && stored !== header.hash;
  }

  // The next ledger must build directly on the checkpoint.
  if (header.sequence === checkpoint.sequence + 1) {
    return header.parentHash !== checkpoint.hash;
  }

  // A gap: the parent must still match the stored hash of the previous ledger.
  const parent = await store.getLedgerHash(header.sequence - 1);
  return parent !== null && parent !== header.parentHash;
}

/**
 * Walks back from the checkpoint to the last ledger whose stored hash still matches the
 * canonical chain, rolls the database back to that common ancestor, and returns its sequence.
 */
export async function rollbackToCommonAncestor(
  store: ReorgStore,
  canonical: (sequence: number) => Promise<string | null>,
): Promise<number | null> {
  const checkpoint = await store.getCheckpoint();
  if (!checkpoint) return null;

  let sequence = checkpoint.sequence;
  while (sequence > 0) {
    const stored = await store.getLedgerHash(sequence);
    const expected = await canonical(sequence);
    if (stored !== null && expected !== null && stored === expected) {
      // Roll back everything applied after the common ancestor.
      await store.rollbackTo(sequence + 1);
      await store.setCheckpoint({ sequence, hash: stored });
      return sequence;
    }
    sequence -= 1;
  }

  // No common ancestor found: roll back everything.
  await store.rollbackTo(1);
  return null;
}

/**
 * Reconciles an incoming header against the stored chain. When a fork is detected the database
 * is rolled back to the last common ancestor and the canonical ledgers are re-ingested.
 * Returns `true` when a reorg was handled.
 */
export async function reconcileLedger(
  store: ReorgStore,
  header: LedgerHeader,
  canonical: (sequence: number) => Promise<string | null>,
  reingest: (fromSequence: number) => Promise<void>,
): Promise<boolean> {
  if (!(await detectReorg(store, header))) return false;

  const ancestor = await rollbackToCommonAncestor(store, canonical);
  await reingest(ancestor === null ? 1 : ancestor + 1);
  return true;
}
