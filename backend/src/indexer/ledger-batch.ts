/**
 * Batched writes for one ledger (#31).
 *
 * Instead of committing each event alone, the events of a ledger are written together: one
 * multi-row upsert per table, inside one transaction. If any write fails, the whole ledger
 * rolls back, so a ledger is never half applied.
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
 * Tables that are declaratively partitioned by a timestamp column (#252). Writes to these tables
 * must target the parent table so PostgreSQL routes each row to its quarterly partition; the
 * application never names a partition directly.
 */
export const PARTITIONED_TABLES: Readonly<Record<string, string>> = {
  bets: 'placed_at',
};

/**
 * Tables whose rows are locked during a batch write. Concurrent transactions that touch the same
 * rows must acquire those locks in the same order, otherwise PostgreSQL aborts one of them with a
 * deadlock (#254). Rows of these tables are therefore sorted by their lock key before writing.
 */
export const LOCK_ORDER_COLUMNS: Readonly<Record<string, string>> = {
  leaderboard: 'user_address',
};

/**
 * Returns the quarterly partition name for a timestamp, e.g. `bets_2026_q1`. Mirrors the
 * `bets_<year>_q<quarter>` naming used by the partition management routine so the indexer and the
 * provisioning routine agree on boundaries.
 */
export function quarterlyPartitionName(table: string, at: Date): string {
  const year = at.getUTCFullYear();
  const quarter = Math.floor(at.getUTCMonth() / 3) + 1;
  return `${table}_${year}_q${quarter}`;
}

/**
 * Sorts rows of a lock-ordered table by their lock key (ascending) so every transaction locks the
 * shared rows in the same deterministic order. This is what prevents the deadlocks described in
 * #254 when concurrent bet settlements update overlapping leaderboard rows.
 */
function orderForLocking(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const column = LOCK_ORDER_COLUMNS[table];
  if (!column) return rows;
  return [...rows].sort((a, b) => {
    const left = String(a[column] ?? '');
    const right = String(b[column] ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Writes every event of one ledger in a single transaction. Rows are grouped per table, so each
 * table gets one multi-row statement instead of one statement per event.
 *
 * Partitioned tables are written through their parent table, so partitioning stays transparent to
 * callers and no query changes are required. Lock-ordered tables are sorted by their lock key so
 * concurrent transactions acquire row locks deterministically and cannot deadlock (#254).
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
      await tx.upsertMany(table, orderForLocking(table, rows));
    }
  });
}
