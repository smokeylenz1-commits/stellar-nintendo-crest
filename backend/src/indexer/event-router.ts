/**
 * Single event router for live indexing and backfill (#21, #23).
 *
 * Every contract event goes through `dispatchContractEvent`, which looks up its topic and calls
 * the one handler registered for it. Live polling and the backfill runner both use this router,
 * so both run the same handler code. Topics with no handler are reported, not dropped.
 */

import type { RawContractEvent } from "./event-schema";

export type EventHandler = (event: RawContractEvent) => Promise<void>;

export type UnmappedHandler = (event: RawContractEvent) => void;

/**
 * PostgreSQL pool tuning for the indexer runner (#217). Bursts of hundreds of concurrent bet
 * events otherwise exhaust the pool and time out queries, so the pool is bounded and every
 * statement is capped.
 */
export interface PoolConfig {
  min: number;
  max: number;
  statementTimeoutMs: number;
  idleTimeoutMs: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 5,
  max: 30,
  statementTimeoutMs: 5000,
  idleTimeoutMs: 10000,
};

/**
 * Runs `work` against a pooled connection and always releases it (#217). The `finally` block
 * guarantees release even when the handler throws, so a failing event cannot leak a connection.
 */
export async function withPooledConnection<T>(
  acquire: () => Promise<T>,
  release: (connection: T) => void,
  work: (connection: T) => Promise<void>,
): Promise<void> {
  const connection = await acquire();
  try {
    await work(connection);
  } finally {
    release(connection);
  }
}

/**
 * Retries `work` with exponential backoff when the pool is saturated (#217). Transient pool
 * exhaustion is retried a bounded number of times; any other error is rethrown immediately.
 */
export async function withPoolRetry<T>(
  work: () => Promise<T>,
  isPoolExhausted: (error: unknown) => boolean,
  maxAttempts = 5,
  baseDelayMs = 50,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || !isPoolExhausted(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

/**
 * A dead-letter record for an event that could not be decoded or validated (#218). The raw
 * payload, error message/stack and ledger sequence are persisted so the event can be inspected
 * and retried from the admin CLI instead of crashing the indexer.
 */
export interface DlqEntry {
  topic: string;
  ledgerSequence: number;
  rawPayload: unknown;
  errorMessage: string;
  errorStack: string | null;
}

/** Persists a failed event to the `indexer_dlq` table (#218). */
export type DlqWriter = (entry: DlqEntry) => Promise<void>;

/**
 * Serializes an error into a DLQ entry (#218). Non-`Error` throws are stringified so the raw
 * failure is never lost.
 */
export function toDlqEntry(event: RawContractEvent, error: unknown): DlqEntry {
  const ledgerSequence =
    typeof event.ledgerSequence === "number" ? event.ledgerSequence : 0;
  if (error instanceof Error) {
    return {
      topic: event.topic,
      ledgerSequence,
      rawPayload: event.data,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
    };
  }
  return {
    topic: event.topic,
    ledgerSequence,
    rawPayload: event.data,
    errorMessage: String(error),
    errorStack: null,
  };
}

/**
 * Per-invocation gas and resource telemetry (#219). `cpuInstructions` and `ramBytes` come from
 * the transaction envelope result; `feeStroops` is the fee actually paid. `contractMethod` is
 * the contract function that was invoked, used to aggregate consumption trends.
 */
export interface TxTelemetry {
  txHash: string;
  contractMethod: string;
  cpuInstructions: number;
  ramBytes: number;
  feeStroops: bigint;
  ledgerSequence: number;
}

/** Persists one telemetry row to the `tx_telemetry` table (#219). */
export type TxTelemetryWriter = (telemetry: TxTelemetry) => Promise<void>;

/**
 * Extracts gas and resource telemetry from a raw contract event's envelope result (#219).
 * Returns `null` when the event carries no telemetry (e.g. backfilled events without envelope
 * data) so ingestion is never blocked by missing metrics.
 *
 * Expected payload shape: `{ txHash, contractMethod, cpuInstructions, ramBytes, feeStroops }`.
 */
export function extractTxTelemetry(event: RawContractEvent): TxTelemetry | null {
  const payload = event.data as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const txHash = payload.txHash;
  const contractMethod = payload.contractMethod;
  if (typeof txHash !== "string" || txHash.length === 0) {
    return null;
  }
  if (typeof contractMethod !== "string" || contractMethod.length === 0) {
    return null;
  }

  const cpuInstructions = toNonNegativeInt(payload.cpuInstructions);
  const ramBytes = toNonNegativeInt(payload.ramBytes);
  const feeStroops = toNonNegativeBigInt(payload.feeStroops);
  if (cpuInstructions === null || ramBytes === null || feeStroops === null) {
    return null;
  }

  const ledgerSequence =
    typeof event.ledgerSequence === "number" ? event.ledgerSequence : 0;

  return { txHash, contractMethod, cpuInstructions, ramBytes, feeStroops, ledgerSequence };
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function toNonNegativeBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") {
      return value >= 0n ? value : null;
    }
    if (typeof value === "string" && value.length > 0) {
      const parsed = BigInt(value);
      return parsed >= 0n ? parsed : null;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return BigInt(Math.trunc(value));
    }
  } catch {
    return null;
  }
  return null;
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();

  constructor(
    private readonly onUnmapped: UnmappedHandler,
    private readonly dlqWriter?: DlqWriter,
    private readonly telemetryWriter?: TxTelemetryWriter,
  ) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /**
   * Routes one event to its handler. Returns `false` when no handler is registered. When a
   * handler throws (decode/validation failure), the event is written to the DLQ and `false` is
   * returned so a single bad event cannot crash the indexer (#218).
   *
   * Gas/resource telemetry is recorded alongside the handler (#219). Telemetry failures are
   * swallowed so they never affect ingestion latency or correctness.
   */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    const handler = this.handlers.get(event.topic);
    if (!handler) {
      this.onUnmapped(event);
      return false;
    }
    try {
      await handler(event);
      await this.recordTelemetry(event);
      return true;
    } catch (error) {
      if (this.dlqWriter) {
        await this.dlqWriter(toDlqEntry(event, error));
      }
      return false;
    }
  }

  private async recordTelemetry(event: RawContractEvent): Promise<void> {
    if (!this.telemetryWriter) {
      return;
    }
    const telemetry = extractTxTelemetry(event);
    if (!telemetry) {
      return;
    }
    try {
      await this.telemetryWriter(telemetry);
    } catch {
      // Telemetry is best-effort; never fail ingestion over it (#219).
    }
  }
}

/**
 * Builds the router with the user-facing handlers wired in (#21): claims, fee withdrawals and
 * loyalty points. Each handler is supplied by the caller, so the store is injected, not global.
 */
export function buildUserEventRouter(
  handlers: {
    claim: EventHandler;
    feeWithdrawn: EventHandler;
    rewardPoints: EventHandler;
  },
  onUnmapped: UnmappedHandler,
  dlqWriter?: DlqWriter,
  telemetryWriter?: TxTelemetryWriter,
): EventRouter {
  const router = new EventRouter(onUnmapped, dlqWriter, telemetryWriter);
  router.register("claim", handlers.claim);
  router.register("fee_withdrawn", handlers.feeWithdrawn);
  router.register("reward_points", handlers.rewardPoints);
  return router;
}

/**
 * A decoded IPREDICT SAC token event (#216). `transfer` moves tokens between wallets, `mint`
 * awards new tokens to a recipient. `marketId` is present when the event can be attributed to
 * a specific market (e.g. a mint triggered by a market resolution).
 */
export interface TokenEvent {
  kind: "transfer" | "mint";
  from: string | null;
  to: string;
  amount: bigint;
  marketId: string | null;
}

/**
 * Decodes a raw SAC-style token event into a `TokenEvent` (#216). Returns `null` when the event
 * is not a token `transfer`/`mint` event or its payload is malformed, so callers can skip it.
 *
 * Expected payload shape: `{ from?, to, amount, marketId? }` where `amount` is a decimal string
 * or number. `mint` events have no `from`; `transfer` events require one.
 */
export function decodeTokenEvent(event: RawContractEvent): TokenEvent | null {
  if (event.topic !== "transfer" && event.topic !== "mint") {
    return null;
  }

  const payload = event.data as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const to = payload.to;
  if (typeof to !== "string" || to.length === 0) {
    return null;
  }

  const rawAmount = payload.amount;
  let amount: bigint;
  try {
    if (typeof rawAmount === "bigint") {
      amount = rawAmount;
    } else if (typeof rawAmount === "string" && rawAmount.length > 0) {
      amount = BigInt(rawAmount);
    } else if (typeof rawAmount === "number" && Number.isFinite(rawAmount)) {
      amount = BigInt(Math.trunc(rawAmount));
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const rawFrom = payload.from;
  const from = typeof rawFrom === "string" && rawFrom.length > 0 ? rawFrom : null;
  if (event.topic === "transfer" && from === null) {
    return null;
  }

  const rawMarketId = payload.marketId;
  const marketId =
    typeof rawMarketId === "string" && rawMarketId.length > 0 ? rawMarketId : null;

  return { kind: event.topic, from, to, amount, marketId };
}

/**
 * Builds the router with the IPREDICT token handlers wired in (#216): `transfer` and `mint`
 * events are decoded and handed to the caller-supplied ledger writer, which persists them to
 * the `token_transfers` table. Undecodable token events are written to the DLQ (#218) when a
 * writer is supplied, otherwise reported via `onUnmapped`.
 */
export function buildTokenEventRouter(
  handlers: {
    recordTokenEvent: (event: TokenEvent) => Promise<void>;
  },
  onUnmapped: UnmappedHandler,
  dlqWriter?: DlqWriter,
  telemetryWriter?: TxTelemetryWriter,
): EventRouter {
  const router = new EventRouter(onUnmapped, dlqWriter, telemetryWriter);
  const route = async (event: RawContractEvent): Promise<void> => {
    const decoded = decodeTokenEvent(event);
    if (!decoded) {
      if (dlqWriter) {
        await dlqWriter(toDlqEntry(event, new Error("undecodable token event")));
      } else {
        onUnmapped(event);
      }
      return;
    }
    await handlers.recordTokenEvent(decoded);
  };
  router.register("transfer", route);
  router.register("mint", route);
  return router;
}
