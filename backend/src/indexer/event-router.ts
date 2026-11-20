/**
 * Single event router for live indexing and backfill (#21, #23).
 *
 * Every contract event goes through `dispatchContractEvent`, which looks up its topic and calls
 * the one handler registered for it. Live polling and the backfill runner both use this router,
 * so both run the same handler code. Topics with no handler are reported, not dropped.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RawContractEvent } from "./event-schema";

export type EventHandler = (event: RawContractEvent) => Promise<void>;

export type UnmappedHandler = (event: RawContractEvent) => void;

/**
 * Prometheus metrics for the indexer (#214).
 *
 * Exposes the latest indexed ledger, the gap to the chain tip, and a per-topic ingestion
 * duration histogram so operators can alert on lag and slow handlers. The registry is
 * self-contained so it can be served from a `/metrics` route without touching globals.
 */
export class IndexerMetrics {
  readonly registry = new Registry();
  readonly latestLedger: Gauge<string>;
  readonly chainTipLedger: Gauge<string>;
  readonly lagLedgers: Gauge<string>;
  readonly ingestionDuration: Histogram<string>;
  readonly eventsProcessed: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.latestLedger = new Gauge({
      name: "stellar_indexer_latest_ledger",
      help: "Latest ledger sequence fully indexed by the indexer",
      registers: [this.registry],
    });
    this.chainTipLedger = new Gauge({
      name: "stellar_indexer_chain_tip_ledger",
      help: "Latest ledger sequence observed at the Stellar chain tip",
      registers: [this.registry],
    });
    this.lagLedgers = new Gauge({
      name: "stellar_indexer_lag_ledgers",
      help: "Number of ledgers the indexer is behind the chain tip",
      registers: [this.registry],
    });
    this.ingestionDuration = new Histogram({
      name: "stellar_indexer_event_ingestion_seconds",
      help: "Contract event ingestion duration in seconds, per event topic",
      labelNames: ["topic"],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });
    this.eventsProcessed = new Counter({
      name: "stellar_indexer_events_processed_total",
      help: "Total contract events processed, per event topic",
      labelNames: ["topic"],
      registers: [this.registry],
    });
  }

  /** Records the latest indexed ledger and recomputes lag against the known chain tip. */
  setLatestLedger(ledger: number): void {
    this.latestLedger.set(ledger);
    const tip = this.chainTipLedger.hashMap[""]?.value;
    if (typeof tip === "number") {
      this.lagLedgers.set(Math.max(0, tip - ledger));
    }
  }

  /** Records the observed chain tip and recomputes lag against the latest indexed ledger. */
  setChainTip(ledger: number): void {
    this.chainTipLedger.set(ledger);
    const latest = this.latestLedger.hashMap[""]?.value;
    if (typeof latest === "number") {
      this.lagLedgers.set(Math.max(0, ledger - latest));
    }
  }

  /** Renders the registry in the Prometheus text exposition format for `/metrics`. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();

  constructor(
    private readonly onUnmapped: UnmappedHandler,
    private readonly metrics?: IndexerMetrics,
  ) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /** Routes one event to its handler. Returns `false` when no handler is registered. */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    const handler = this.handlers.get(event.topic);
    if (!handler) {
      this.onUnmapped(event);
      return false;
    }
    if (!this.metrics) {
      await handler(event);
      return true;
    }
    const end = this.metrics.ingestionDuration.startTimer({ topic: event.topic });
    try {
      await handler(event);
      this.metrics.eventsProcessed.inc({ topic: event.topic });
      return true;
    } finally {
      end();
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
  metrics?: IndexerMetrics,
): EventRouter {
  const router = new EventRouter(onUnmapped, metrics);
  router.register("claim", handlers.claim);
  router.register("fee_withdrawn", handlers.feeWithdrawn);
  router.register("reward_points", handlers.rewardPoints);
  return router;
}

/**
 * Cold-start historic ledger catch-up pipeline (#213).
 *
 * Replays historical contract events from a configurable starting sequence up to the chain tip
 * using paginated `getEvents` queries, then hands off to live stream polling. The pagination
 * cursor and the last fully-synced ledger are persisted atomically in the PostgreSQL checkpoints
 * table so a restart resumes exactly where the previous run stopped.
 */

/** CLI options for the catch-up pipeline: `--from-ledger <seq>` and `--to-ledger <seq>`. */
export interface CatchUpOptions {
  /** First ledger to replay. Defaults to the contract deployment sequence. */
  fromLedger?: number;
  /** Last ledger to replay. Defaults to the current chain tip. */
  toLedger?: number;
}

/** One page of events returned by a paginated `getEvents` query. */
export interface EventPage {
  events: RawContractEvent[];
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  cursor: string | null;
}

/** Fetches one page of events starting at `cursor` (or the start of the range when `null`). */
export type GetEventsPage = (
  fromLedger: number,
  toLedger: number,
  cursor: string | null,
) => Promise<EventPage>;

/** Persists sync progress. Implementations must write the cursor and ledger atomically. */
export interface CheckpointStore {
  load(): Promise<{ cursor: string | null; lastLedger: number } | null>;
  save(cursor: string | null, lastLedger: number): Promise<void>;
}

/** Parses `--from-ledger <seq>` / `--to-ledger <seq>` from CLI args. */
export function parseCatchUpArgs(argv: string[]): CatchUpOptions {
  const options: CatchUpOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (): number => {
      const raw = argv[i + 1];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`invalid ledger sequence for ${arg}: ${raw ?? "<missing>"}`);
      }
      i += 1;
      return value;
    };
    if (arg === "--from-ledger") {
      options.fromLedger = readValue();
    } else if (arg === "--to-ledger") {
      options.toLedger = readValue();
    }
  }
  if (
    options.fromLedger !== undefined &&
    options.toLedger !== undefined &&
    options.fromLedger > options.toLedger
  ) {
    throw new Error(
      `--from-ledger (${options.fromLedger}) must not exceed --to-ledger (${options.toLedger})`,
    );
  }
  return options;
}

/**
 * Replays historical events from `fromLedger` to `toLedger`, routing each through the shared
 * router and checkpointing progress after every page. Returns the last synced ledger so the
 * caller can transition to live stream polling from that point.
 */
export async function runCatchUp(
  router: EventRouter,
  getEventsPage: GetEventsPage,
  checkpoints: CheckpointStore,
  options: CatchUpOptions,
  deploymentSequence: number,
  metrics?: IndexerMetrics,
): Promise<{ lastLedger: number }> {
  const fromLedger = options.fromLedger ?? deploymentSequence;
  const toLedger = options.toLedger ?? fromLedger;
  if (fromLedger > toLedger) {
    throw new Error(`from-ledger (${fromLedger}) must not exceed to-ledger (${toLedger})`);
  }

  const saved = await checkpoints.load();
  let cursor: string | null = saved?.cursor ?? null;
  let lastLedger = saved?.lastLedger ?? fromLedger - 1;

  while (lastLedger < toLedger) {
    const page = await getEventsPage(lastLedger + 1, toLedger, cursor);
    for (const event of page.events) {
      await router.dispatchContractEvent(event);
    }
    cursor = page.cursor;
    lastLedger = toLedger;
    await checkpoints.save(cursor, lastLedger);
    metrics?.setChainTip(toLedger);
    metrics?.setLatestLedger(lastLedger);
    if (cursor === null) {
      break;
    }
  }

  return { lastLedger };
}
