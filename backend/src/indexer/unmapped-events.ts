import { Pool } from 'pg';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';

export interface UnmappedEvent {
  ledgerSequence: number;
  contractId: string;
  topic: string;
  payload: unknown;
  reason: string;
}

/**
 * Persist an event that could not be decoded or failed schema validation
 * into the `indexer_dlq` table so the indexer can keep ingesting ledgers.
 * Never throws: DLQ persistence failures are logged and swallowed so a
 * single malformed event cannot crash the daemon.
 */
export async function recordUnmappedEvent(
  event: UnmappedEvent,
  db: Pool = pool,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO indexer_dlq
         (ledger_sequence, contract_id, topic, raw_payload, error_message, error_stack, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
      [
        event.ledgerSequence,
        event.contractId,
        event.topic,
        JSON.stringify(event.payload ?? null),
        event.reason,
        event.reason,
      ],
    );
  } catch (err) {
    logger.error('Failed to persist event to indexer_dlq', {
      ledgerSequence: event.ledgerSequence,
      contractId: event.contractId,
      topic: event.topic,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wrap a decode/validate handler so any thrown error is routed to the DLQ
 * instead of propagating and halting the indexer loop.
 */
export async function withDlq<T>(
  event: UnmappedEvent,
  handler: () => Promise<T>,
  db: Pool = pool,
): Promise<T | undefined> {
  try {
    return await handler();
  } catch (err) {
    const reason = err instanceof Error ? err.stack ?? err.message : String(err);
    await recordUnmappedEvent({ ...event, reason }, db);
    return undefined;
  }
}
