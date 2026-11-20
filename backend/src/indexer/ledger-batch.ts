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

/**
 * One itemized tax-reporting record (#247). Mirrors the columns required by the export:
 * date, tx hash, type, asset, amount, fee, and net payout, plus a USD historical estimate.
 */
export interface TaxLedgerRecord {
  date: string;
  txHash: string;
  type: string;
  asset: string;
  amount: string;
  fee: string;
  netPayout: string;
  usdValue: string;
}

const CSV_COLUMNS: (keyof TaxLedgerRecord)[] = [
  'date',
  'txHash',
  'type',
  'asset',
  'amount',
  'fee',
  'netPayout',
  'usdValue',
];

/** Escapes a single CSV field per RFC 4180 (quotes doubled, wrapped when needed). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Streams itemized tax records as CSV or JSON without buffering the full history in memory.
 * Records are pulled lazily from `source` and written one at a time to `sink`, so arbitrarily
 * large histories can be exported with constant memory.
 */
export async function streamTaxExport(
  source: AsyncIterable<TaxLedgerRecord>,
  sink: { write(chunk: string): void | Promise<void> },
  format: 'csv' | 'json',
): Promise<void> {
  if (format === 'csv') {
    await sink.write(CSV_COLUMNS.join(',') + '\n');
    for await (const record of source) {
      const line = CSV_COLUMNS.map((col) => csvField(record[col])).join(',');
      await sink.write(line + '\n');
    }
    return;
  }

  await sink.write('[');
  let first = true;
  for await (const record of source) {
    await sink.write((first ? '' : ',') + JSON.stringify(record));
    first = false;
  }
  await sink.write(']');
}
