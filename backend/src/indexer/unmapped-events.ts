/**
 * Telemetry for contract events with no handler (#32).
 *
 * When a new event is deployed on-chain before the indexer knows it, the router reports it here
 * rather than dropping it silently. Each report logs a structured warning and increments the
 * `indexer_unmapped_events_total` counter.
 *
 * Multi-contract listening (#221): reports carry the emitting contract ID so operators can tell
 * which monitored deployment produced the unmapped event, and the log line is prefixed with the
 * source contract for easy grepping across concurrent listeners.
 */

import { incCounter, indexerUnmappedEventsTotal } from "./metrics";

export interface UnmappedEventContext {
  topic: string;
  contractId: string;
  ledger: number;
}

export interface WarnLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Builds the log prefix identifying the source contract for a given log line. */
export function contractLogPrefix(contractId: string): string {
  return `[contract:${contractId}]`;
}

/** Logs and counts one event whose topic has no handler. */
export function reportUnmappedEvent(logger: WarnLogger, ctx: UnmappedEventContext): void {
  logger.warn(
    { event: "unmapped_contract_event", topic: ctx.topic, contractId: ctx.contractId, ledger: ctx.ledger },
    `${contractLogPrefix(ctx.contractId)} Contract event has no indexer handler`,
  );
  incCounter(indexerUnmappedEventsTotal, 1, { topic: ctx.topic, contractId: ctx.contractId });
}
