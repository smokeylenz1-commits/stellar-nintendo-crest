/**
 * Dead-letter queue retry worker (#26).
 *
 * Runs every five minutes over `dlq_events`. Each unhandled item with `retry_count < MAX_RETRIES`
 * is dispatched again. An item that fails is retried after an exponential backoff. An item that
 * reaches the limit is marked permanent and reported, with its stack trace kept for debugging.
 *
 * Also provides the admin CLI surface (#218) to inspect and retry DLQ items, and the helper used
 * by the indexer event path to persist unparsable/malformed events into `indexer_dlq`.
 */

export const DLQ_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 30_000;

export interface DeadLetter {
  id: number;
  retryCount: number;
  lastError: string;
  payload: unknown;
}

export interface DlqStore {
  /** Items that are unhandled and have `retry_count < MAX_RETRIES`. */
  pendingRetries(): Promise<DeadLetter[]>;
  markHandled(id: number): Promise<void>;
  recordFailure(id: number, error: string, retryCount: number): Promise<void>;
  markPermanent(id: number, error: string, stack: string | undefined): Promise<void>;
}

/** Backoff before the next attempt: 30 s, 60 s, 120 s, and so on. */
export function backoffMs(retryCount: number): number {
  return BASE_BACKOFF_MS * 2 ** retryCount;
}

export interface DlqRetryDeps {
  store: DlqStore;
  dispatch(payload: unknown): Promise<void>;
  alert(message: string): void;
}

/**
 * One pass of the worker. Returns how many items were handled on this pass.
 */
export async function retryDeadLetters(deps: DlqRetryDeps): Promise<number> {
  let handled = 0;
  for (const item of await deps.store.pendingRetries()) {
    try {
      await deps.dispatch(item.payload);
      await deps.store.markHandled(item.id);
      handled++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryCount = item.retryCount + 1;
      if (retryCount >= MAX_RETRIES) {
        const stack = err instanceof Error ? err.stack : undefined;
        await deps.store.markPermanent(item.id, message, stack);
        deps.alert(`DLQ item ${item.id} failed ${MAX_RETRIES} times and needs a developer: ${message}`);
      } else {
        await deps.store.recordFailure(item.id, message, retryCount);
      }
    }
  }
  return handled;
}

/**
 * Persistence surface for the `indexer_dlq` table (#218).
 *
 * The indexer event path calls `record` whenever an event fails decoding or schema validation,
 * so a single malformed event is captured instead of crashing the daemon.
 */
export interface IndexerDlqStore {
  record(entry: IndexerDlqEntry): Promise<number>;
  list(limit: number): Promise<IndexerDlqRow[]>;
  get(id: number): Promise<IndexerDlqRow | undefined>;
  markRetried(id: number): Promise<void>;
}

export interface IndexerDlqEntry {
  ledgerSequence: number;
  payload: unknown;
  errorMessage: string;
  errorStack?: string;
}

export interface IndexerDlqRow extends IndexerDlqEntry {
  id: number;
  retryCount: number;
  retriedAt: Date | null;
  createdAt: Date;
}

/**
 * Serialize a raw event payload for storage. Falls back to a string form when the payload is not
 * JSON-serializable (e.g. BigInt or circular references) so recording never throws.
 */
export function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  } catch {
    return String(payload);
  }
}

/**
 * Capture a failed event into the DLQ. Never throws: a failure to record must not take down the
 * indexer, so the error is reported through `alert` instead.
 */
export async function recordMalformedEvent(
  store: IndexerDlqStore,
  entry: IndexerDlqEntry,
  alert: (message: string) => void,
): Promise<number | undefined> {
  try {
    return await store.record(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    alert(`Failed to record malformed event at ledger ${entry.ledgerSequence}: ${message}`);
    return undefined;
  }
}

/**
 * Admin CLI: inspect DLQ items. Returns the most recent rows for display.
 */
export async function inspectDlq(store: IndexerDlqStore, limit = 50): Promise<IndexerDlqRow[]> {
  return store.list(limit);
}

/**
 * Admin CLI: retry a single DLQ item by id. Re-dispatches the stored payload; on success the item
 * is marked retried, on failure the error is surfaced to the caller.
 */
export async function retryDlqItem(
  store: IndexerDlqStore,
  id: number,
  dispatch: (payload: unknown) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  const row = await store.get(id);
  if (!row) {
    return { ok: false, error: `DLQ item ${id} not found` };
  }
  try {
    await dispatch(row.payload);
    await store.markRetried(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
