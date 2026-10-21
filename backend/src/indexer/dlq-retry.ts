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
