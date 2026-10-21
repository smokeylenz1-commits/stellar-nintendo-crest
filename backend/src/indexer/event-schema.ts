/**
 * Strict validation at the ledger event parsing boundary (#29).
 *
 * Raw Soroban events are untyped. Each one is checked against its expected shape before any
 * handler sees it, so a malformed payload becomes a reported failure rather than an exception
 * in the ingestion loop. A failure carries the reasons, so the caller can write it to the DLQ.
 *
 * This uses plain type guards instead of zod, because the backend has no schema library
 * installed yet. The shape is the same as a zod schema would describe.
 */

export interface RawContractEvent {
  topic: string;
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  value: unknown;
}

export type ParseResult =
  | { ok: true; event: RawContractEvent }
  | { ok: false; reasons: string[] };

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Checks one raw event. Returns every problem found, not just the first.
 */
export function parseContractEvent(raw: unknown): ParseResult {
  const reasons: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reasons: ["event is not an object"] };
  }
  const e = raw as Record<string, unknown>;

  if (!isString(e.topic)) reasons.push("topic must be a non-empty string");
  if (!isString(e.contractId)) reasons.push("contractId must be a non-empty string");
  if (!isNonNegativeInt(e.ledger)) reasons.push("ledger must be a non-negative integer");
  if (!isString(e.txHash)) reasons.push("txHash must be a non-empty string");
  if (!isNonNegativeInt(e.eventIndex)) reasons.push("eventIndex must be a non-negative integer");
  if (e.value === undefined) reasons.push("value is missing");

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, event: e as unknown as RawContractEvent };
}

/**
 * Parses a batch and routes each failure to `onDeadLetter` instead of throwing, so one bad
 * event never stops the loop. Returns the events that passed.
 */
export function parseEventsOrDeadLetter(
  raws: unknown[],
  onDeadLetter: (raw: unknown, reasons: string[]) => void,
): RawContractEvent[] {
  const valid: RawContractEvent[] = [];
  for (const raw of raws) {
    try {
      const result = parseContractEvent(raw);
      if (result.ok) {
        valid.push(result.event);
      } else {
        onDeadLetter(raw, result.reasons);
      }
    } catch (err) {
      onDeadLetter(raw, [`parser threw: ${String(err)}`]);
    }
  }
  return valid;
}
