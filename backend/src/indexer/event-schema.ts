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

/**
 * Computes a deterministic event hash from `(ledger_sequence, tx_hash, event_index)` (#220).
 *
 * The same on-chain event always yields the same hash, so a restart that re-reads a partially
 * processed ledger produces identical hashes. Persisting this value in a `UNIQUE` column and
 * inserting with `ON CONFLICT DO NOTHING` makes writes idempotent: duplicate bet rows and
 * inflated pool totals are prevented at the database level.
 *
 * Uses FNV-1a (64-bit) so the hash is stable across processes and needs no crypto dependency.
 */
export function computeEventHash(
  ledgerSequence: number,
  txHash: string,
  eventIndex: number,
): string {
  const input = `${ledgerSequence}:${txHash}:${eventIndex}`;
  // FNV-1a 64-bit constants.
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;

  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Convenience wrapper: derives the event hash for a validated raw event.
 */
export function eventHashFor(event: RawContractEvent): string {
  return computeEventHash(event.ledger, event.txHash, event.eventIndex);
}

/**
 * Domain parser identifiers. Each monitored contract is mapped to one of these, so events are
 * routed to the correct parser based on the emitting contract ID (#221).
 */
export type DomainParserId = "prediction-market" | "governance" | "sidecar-registry";

/**
 * One entry in the monitored-contract configuration. `address` is the on-chain contract ID and
 * `parser` selects the domain parser that handles its events.
 */
export interface MonitoredContract {
  address: string;
  parser: DomainParserId;
  /** Optional human-readable label used in log prefixes. Defaults to the parser id. */
  label?: string;
}

/**
 * Loads the array of monitored contracts from a JSON config value (env var or config file
 * contents). Accepts either a bare array or an object with a `contracts` array.
 *
 * Invalid entries are skipped and reported via `onInvalid` rather than throwing, so a single
 * bad entry never prevents the remaining contracts from being monitored.
 */
export function loadMonitoredContracts(
  raw: string | undefined,
  onInvalid: (reason: string) => void = () => {},
): MonitoredContract[] {
  if (!raw || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onInvalid(`monitored contracts config is not valid JSON: ${String(err)}`);
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).contracts)
      ? ((parsed as Record<string, unknown>).contracts as unknown[])
      : null;

  if (list === null) {
    onInvalid("monitored contracts config must be an array or an object with a contracts array");
    return [];
  }

  const validParsers: DomainParserId[] = ["prediction-market", "governance", "sidecar-registry"];
  const contracts: MonitoredContract[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      onInvalid("contract entry is not an object");
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isString(e.address)) {
      onInvalid("contract entry is missing a non-empty address");
      continue;
    }
    if (!isString(e.parser) || !validParsers.includes(e.parser as DomainParserId)) {
      onInvalid(`contract ${e.address} has an unknown parser: ${String(e.parser)}`);
      continue;
    }
    if (seen.has(e.address)) {
      onInvalid(`duplicate contract address ignored: ${e.address}`);
      continue;
    }
    seen.add(e.address);
    contracts.push({
      address: e.address,
      parser: e.parser as DomainParserId,
      label: isString(e.label) ? e.label : undefined,
    });
  }

  return contracts;
}

/**
 * Builds a lookup from contract address to its monitored-contract entry. Used to route each
 * event to the appropriate domain parser based on the emitting contract ID (#221).
 */
export function buildContractRouter(
  contracts: MonitoredContract[],
): Map<string, MonitoredContract> {
  const router = new Map<string, MonitoredContract>();
  for (const contract of contracts) {
    router.set(contract.address, contract);
  }
  return router;
}

/**
 * Resolves the monitored contract for an event, or `undefined` when the emitting contract is
 * not configured. Callers can use this to skip unknown contracts without stopping listeners.
 */
export function routeEvent(
  router: Map<string, MonitoredContract>,
  event: RawContractEvent,
): MonitoredContract | undefined {
  return router.get(event.contractId);
}

/**
 * Formats a log prefix identifying the source contract for a log line (#221).
 */
export function contractLogPrefix(contract: MonitoredContract): string {
  return `[${contract.label ?? contract.parser}:${contract.address}]`;
}
