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

import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

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

/**
 * Typed model for a decoded Soroban ScVal topic (#212).
 */
export type ScValTopic =
  | { kind: "symbol"; value: string }
  | { kind: "address"; value: string; addressType: "account" | "contract" | "muxed" }
  | { kind: "i128"; value: string }
  | { kind: "u64"; value: string }
  | { kind: "vec"; value: ScValTopic[] };

export type ScValParseResult =
  | { ok: true; topic: ScValTopic }
  | { ok: false; reasons: string[] };

/**
 * Decodes a single raw ScVal topic into a typed model. Uses `@stellar/stellar-sdk` with strict
 * type checking and an exhaustive switch over the ScVal variants we support. Unexpected shapes
 * are reported (with the raw hex payload) instead of throwing.
 */
export function parseScValTopic(raw: unknown): ScValParseResult {
  let scv: xdr.ScVal;
  try {
    scv = typeof raw === "string" ? xdr.ScVal.fromXDR(raw, "base64") : (raw as xdr.ScVal);
  } catch (err) {
    return { ok: false, reasons: [`unable to decode ScVal: ${String(err)}`] };
  }

  if (!scv || typeof scv.switch !== "function") {
    return { ok: false, reasons: ["unexpected ScVal shape: not an ScVal"] };
  }

  const rawHex = safeHex(scv);
  try {
    return { ok: true, topic: decodeScVal(scv) };
  } catch (err) {
    return {
      ok: false,
      reasons: [`unexpected ScVal shape (${String(err)}); raw=${rawHex}`],
    };
  }
}

function safeHex(scv: xdr.ScVal): string {
  try {
    return scv.toXDR().toString("hex");
  } catch {
    return "<unencodable>";
  }
}

function decodeScVal(scv: xdr.ScVal): ScValTopic {
  switch (scv.switch().name) {
    case "scvSymbol":
      return { kind: "symbol", value: scv.sym().toString() };
    case "scvAddress": {
      const address = Address.fromScVal(scv);
      const addressType = address.type();
      return { kind: "address", value: address.toString(), addressType };
    }
    case "scvI128": {
      const native = scValToNative(scv) as bigint;
      return { kind: "i128", value: native.toString() };
    }
    case "scvU64": {
      const native = scValToNative(scv) as bigint;
      return { kind: "u64", value: native.toString() };
    }
    case "scvVec": {
      const items = scv.vec() ?? [];
      return { kind: "vec", value: items.map((item) => decodeScVal(item)) };
    }
    default:
      throw new Error(`unsupported ScVal variant: ${scv.switch().name}`);
  }
}

/**
 * Event types broadcast to frontend WebSocket clients (#211).
 */
export type BroadcastEventType = "bet.placed" | "market.resolved" | "dispute.created";

const BROADCAST_EVENT_TYPES: readonly BroadcastEventType[] = [
  "bet.placed",
  "market.resolved",
  "dispute.created",
];

/**
 * Envelope published to the WebSocket bridge. `marketId` is the topic clients filter on so
 * they only receive events for markets they subscribe to.
 */
export interface BroadcastEvent {
  type: BroadcastEventType;
  marketId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  payload: unknown;
  emittedAt: string;
}

export type BroadcastParseResult =
  | { ok: true; event: BroadcastEvent }
  | { ok: false; reasons: string[] };

/**
 * Maps a validated raw contract event to a broadcast envelope, or returns null when the topic
 * is not one of the broadcast event types. The market id is read from the event value so the
 * bridge can route it to the matching `market_id` topic.
 */
export function toBroadcastEvent(event: RawContractEvent): BroadcastEvent | null {
  const type = event.topic as BroadcastEventType;
  if (!BROADCAST_EVENT_TYPES.includes(type)) return null;

  const value = event.value as Record<string, unknown> | null;
  const marketId =
    value && typeof value === "object" && isString((value as Record<string, unknown>).marketId)
      ? ((value as Record<string, unknown>).marketId as string)
      : undefined;
  if (!marketId) return null;

  return {
    type,
    marketId,
    ledger: event.ledger,
    txHash: event.txHash,
    eventIndex: event.eventIndex,
    payload: event.value,
    emittedAt: new Date().toISOString(),
  };
}

/**
 * Validates a broadcast envelope received from the pub/sub channel before it is fanned out to
 * WebSocket clients, so a malformed message never reaches a client.
 */
export function parseBroadcastEvent(raw: unknown): BroadcastParseResult {
  const reasons: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reasons: ["broadcast event is not an object"] };
  }
  const e = raw as Record<string, unknown>;

  if (!isString(e.type) || !BROADCAST_EVENT_TYPES.includes(e.type as BroadcastEventType)) {
    reasons.push(`type must be one of ${BROADCAST_EVENT_TYPES.join(", ")}`);
  }
  if (!isString(e.marketId)) reasons.push("marketId must be a non-empty string");
  if (!isNonNegativeInt(e.ledger)) reasons.push("ledger must be a non-negative integer");
  if (!isString(e.txHash)) reasons.push("txHash must be a non-empty string");
  if (!isNonNegativeInt(e.eventIndex)) reasons.push("eventIndex must be a non-negative integer");
  if (!isString(e.emittedAt)) reasons.push("emittedAt must be a non-empty string");

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, event: e as unknown as BroadcastEvent };
}
