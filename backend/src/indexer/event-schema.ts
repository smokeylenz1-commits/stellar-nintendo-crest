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
 * A dead-letter record for an event that could not be parsed or validated (#218).
 *
 * The raw payload is serialized so an operator can inspect and retry it later via the admin
 * CLI. `ledger` is best-effort: it is extracted from the raw event when present so the DLQ row
 * can be correlated with the ingestion position even when the rest of the shape is invalid.
 */
export interface DeadLetterRecord {
  /** JSON-serialized raw event payload. */
  payload: string;
  /** Human-readable error message (joined validation reasons or thrown error). */
  errorMessage: string;
  /** Stack trace when the failure came from a thrown exception; null for validation failures. */
  errorStack: string | null;
  /** Ledger sequence the event belongs to, when it could be recovered from the payload. */
  ledger: number | null;
}

/**
 * Serializes a raw event payload to JSON without throwing on circular or non-serializable data.
 */
const serializePayload = (raw: unknown): string => {
  try {
    const json = JSON.stringify(raw);
    return json === undefined ? String(raw) : json;
  } catch (err) {
    return `[unserializable payload: ${String(err)}]`;
  }
};

/**
 * Best-effort extraction of the ledger sequence from a raw event, used to correlate DLQ rows.
 */
const extractLedger = (raw: unknown): number | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const ledger = (raw as Record<string, unknown>).ledger;
  return isNonNegativeInt(ledger) ? ledger : null;
};

/**
 * Builds a DLQ record from a failed event. Accepts either validation reasons or a thrown error
 * so both failure modes are captured with the same shape.
 */
export function buildDeadLetterRecord(
  raw: unknown,
  reasons: string[],
  err?: unknown,
): DeadLetterRecord {
  const errorMessage = err !== undefined ? String(err) : reasons.join("; ");
  const errorStack =
    err instanceof Error && typeof err.stack === "string" ? err.stack : null;
  return {
    payload: serializePayload(raw),
    errorMessage: errorMessage.length > 0 ? errorMessage : "unknown parse failure",
    errorStack,
    ledger: extractLedger(raw),
  };
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

/**
 * IPREDICT SAC token event decoding (#216).
 *
 * The token contract emits SAC-style events whose topic is `transfer` or `mint`. Each decoded
 * event is normalized into a row for the `token_transfers` ledger table so users get an
 * itemized audit trail of token awards. Mint events are attributed to the recipient wallet and
 * carry the associated market ID when the event payload includes one.
 */

export type TokenEventKind = "transfer" | "mint";

export interface TokenTransferRow {
  kind: TokenEventKind;
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  /** Sender wallet; null for mint events (tokens created, no source). */
  fromWallet: string | null;
  /** Recipient wallet; for mints this is the awarded user. */
  toWallet: string;
  /** Raw token amount as a decimal string to avoid precision loss. */
  amount: string;
  /** Market the award relates to, when present on the event. */
  marketId: string | null;
}

export type TokenEventParseResult =
  | { ok: true; row: TokenTransferRow }
  | { ok: false; reasons: string[] };

const TOKEN_EVENT_KINDS: readonly TokenEventKind[] = ["transfer", "mint"];

const isTokenEventKind = (v: unknown): v is TokenEventKind =>
  typeof v === "string" && (TOKEN_EVENT_KINDS as readonly string[]).includes(v);

/**
 * Normalizes a token amount to a decimal string. Accepts numbers, bigint, and numeric strings.
 */
const normalizeAmount = (v: unknown): string | null => {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length > 0 && !Number.isNaN(Number(v))) return v;
  return null;
};

/**
 * Decodes a raw token contract event into a `token_transfers` row.
 *
 * Expected `value` shape: `{ from?, to, amount, marketId? }`. For `mint` events `from` is
 * ignored and `to` is the awarded wallet. Returns every problem found so the caller can DLQ it.
 */
export function parseTokenEvent(raw: unknown): TokenEventParseResult {
  const base = parseContractEvent(raw);
  if (!base.ok) {
    return { ok: false, reasons: base.reasons };
  }
  const event = base.event;
  const reasons: string[] = [];

  if (!isTokenEventKind(event.topic)) {
    return { ok: false, reasons: [`unsupported token event topic: ${event.topic}`] };
  }
  const kind = event.topic;

  if (typeof event.value !== "object" || event.value === null) {
    return { ok: false, reasons: ["token event value must be an object"] };
  }
  const value = event.value as Record<string, unknown>;

  const toWallet = value.to;
  if (!isString(toWallet)) reasons.push("to wallet must be a non-empty string");

  let fromWallet: string | null = null;
  if (kind === "transfer") {
    if (!isString(value.from)) {
      reasons.push("from wallet must be a non-empty string for transfer events");
    } else {
      fromWallet = value.from;
    }
  }

  const amount = normalizeAmount(value.amount);
  if (amount === null) reasons.push("amount must be a numeric value");

  let marketId: string | null = null;
  if (value.marketId !== undefined && value.marketId !== null) {
    if (!isString(value.marketId)) {
      reasons.push("marketId must be a non-empty string when present");
    } else {
      marketId = value.marketId;
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    row: {
      kind,
      contractId: event.contractId,
      ledger: event.ledger,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      fromWallet,
      toWallet: toWallet as string,
      amount: amount as string,
      marketId,
    },
  };
}

/**
 * Decodes a batch of token events, routing failures to `onDeadLetter` and returning the rows
 * that decoded successfully. Non-token topics are skipped silently so the same stream can carry
 * other contract events.
 */
export function parseTokenEventsOrDeadLetter(
  raws: unknown[],
  onDeadLetter: (raw: unknown, reasons: string[]) => void,
): TokenTransferRow[] {
  const rows: TokenTransferRow[] = [];
  for (const raw of raws) {
    try {
      const topic = (raw as Record<string, unknown> | null)?.topic;
      if (!isTokenEventKind(topic)) continue;
      const result = parseTokenEvent(raw);
      if (result.ok) {
        rows.push(result.row);
      } else {
        onDeadLetter(raw, result.reasons);
      }
    } catch (err) {
      onDeadLetter(raw, [`token parser threw: ${String(err)}`]);
    }
  }
  return rows;
}
