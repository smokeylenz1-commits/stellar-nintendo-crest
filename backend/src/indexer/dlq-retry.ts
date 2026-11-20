/**
 * Dead-letter queue retry worker (#26).
 *
 * Runs every five minutes over `dlq_events`. Each unhandled item with `retry_count < MAX_RETRIES`
 * is dispatched again. An item that fails is retried after an exponential backoff. An item that
 * reaches the limit is marked permanent and reported, with its stack trace kept for debugging.
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
 * Batched insert buffer (#210).
 *
 * Accumulates high-frequency events (e.g. `BetPlacedEvent`) and flushes them as a single
 * `INSERT ... ON CONFLICT` statement inside an atomic transaction. Flushes happen when the
 * buffer reaches `maxBatchSize` or after `flushIntervalMs` elapses. If a flush fails, the
 * buffered events are retained and re-queued so nothing is dropped; the failure is surfaced
 * through the existing DLQ/alert path.
 */
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

export interface BatchInsertStore<T> {
  /** Executes a single `INSERT ... ON CONFLICT` for the given rows in one transaction. */
  insertBatch(rows: T[]): Promise<void>;
}

export interface BatchWriterDeps<T> {
  store: BatchInsertStore<T>;
  /** Called when a flush fails after events were retained for retry. */
  onFlushError?(error: unknown, retained: T[]): void;
  maxBatchSize?: number;
  flushIntervalMs?: number;
}

export class BatchWriter<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;

  constructor(private readonly deps: BatchWriterDeps<T>) {
    this.maxBatchSize = deps.maxBatchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** Queue an event for insertion. Triggers an immediate flush when the batch is full. */
  enqueue(event: T): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Number of events currently buffered (including retained events after a failure). */
  get pending(): number {
    return this.buffer.length;
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Do not keep the process alive solely for a pending flush.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  /**
   * Flush the current buffer as one atomic batch. On failure the events are retained at the
   * front of the buffer so a later flush retries them; nothing is dropped.
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    this.flushing = (async () => {
      try {
        await this.deps.store.insertBatch(batch);
      } catch (err) {
        // Retain failed events ahead of any newly queued ones so ordering is preserved.
        this.buffer = batch.concat(this.buffer);
        this.deps.onFlushError?.(err, batch);
        this.scheduleFlush();
      } finally {
        this.flushing = null;
      }
    })();

    return this.flushing;
  }

  /** Flush any remaining events and stop the timer. */
  async close(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
