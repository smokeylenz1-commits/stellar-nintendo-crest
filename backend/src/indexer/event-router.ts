/**
 * Single event router for live indexing and backfill (#21, #23).
 *
 * Every contract event goes through `dispatchContractEvent`, which looks up its topic and calls
 * the one handler registered for it. Live polling and the backfill runner both use this router,
 * so both run the same handler code. Topics with no handler are reported, not dropped.
 *
 * Idempotency (#220): each event carries a deterministic `event_hash` derived from
 * `(ledger_sequence, tx_hash, event_index)`. The router tracks hashes it has already dispatched
 * so a restart during a partially processed ledger does not re-run handlers for events that were
 * already applied. Handlers persist the same hash under a UNIQUE constraint and use
 * `ON CONFLICT DO NOTHING`, so duplicate writes are rejected at the database layer too.
 *
 * Multi-contract routing (#221): the router can monitor several contract deployments at once.
 * Each monitored contract is registered with its own set of topic handlers, so events are routed
 * to the correct domain parser based on the emitting contract ID. New contracts can be added at
 * runtime via `addContract` without stopping existing listeners, and every log line is prefixed
 * with the source contract ID.
 */

import type { RawContractEvent } from "./event-schema";

export type EventHandler = (event: RawContractEvent) => Promise<void>;

export type UnmappedHandler = (event: RawContractEvent) => void;

/**
 * Computes the deterministic event hash from ledger sequence, tx hash and event index.
 * The same event always yields the same hash, so it can be used as an idempotency key.
 */
export function computeEventHash(event: RawContractEvent): string {
  return `${event.ledger_sequence}:${event.tx_hash}:${event.event_index}`;
}

/**
 * One monitored contract deployment and the handlers for the topics it emits.
 * Loaded from environment/config so multiple deployments can be indexed concurrently.
 */
export interface MonitoredContract {
  /** On-chain contract ID (address) that emits the events. */
  contractId: string;
  /** Topic -> handler map for this contract's domain parser. */
  handlers: Record<string, EventHandler>;
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();
  private readonly contractHandlers = new Map<string, Map<string, EventHandler>>();
  private readonly processedHashes = new Set<string>();

  constructor(private readonly onUnmapped: UnmappedHandler) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /**
   * Registers a monitored contract and its topic handlers. Can be called at runtime to add a new
   * contract address without stopping existing listeners. Re-registering the same contract ID
   * replaces its handler map so upgraded deployments can be swapped in.
   */
  addContract(contract: MonitoredContract): void {
    const topics = new Map<string, EventHandler>();
    for (const [topic, handler] of Object.entries(contract.handlers)) {
      topics.set(topic, handler);
    }
    this.contractHandlers.set(contract.contractId, topics);
  }

  /** Returns the contract IDs currently being monitored. */
  monitoredContracts(): string[] {
    return [...this.contractHandlers.keys()];
  }

  /**
   * Routes one event to its handler. Returns `false` when no handler is registered or when the
   * event was already processed (duplicate on restart).
   *
   * When the event carries a `contract_id`, the handler is resolved from that contract's map so
   * events are routed to the correct domain parser. Otherwise the global topic handler is used.
   */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    const eventHash = computeEventHash(event);
    if (this.processedHashes.has(eventHash)) {
      return false;
    }

    const contractId = (event as RawContractEvent & { contract_id?: string }).contract_id;
    const handler = contractId
      ? this.contractHandlers.get(contractId)?.get(event.topic)
      : this.handlers.get(event.topic);

    if (!handler) {
      this.onUnmapped(event);
      return false;
    }

    const prefix = contractId ? `[contract:${contractId}]` : "[contract:unknown]";
    console.log(`${prefix} dispatching ${event.topic} (${eventHash})`);

    await handler(event);
    this.processedHashes.add(eventHash);
    return true;
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
): EventRouter {
  const router = new EventRouter(onUnmapped);
  router.register("claim", handlers.claim);
  router.register("fee_withdrawn", handlers.feeWithdrawn);
  router.register("reward_points", handlers.rewardPoints);
  return router;
}

/**
 * Builds a router from a list of monitored contracts loaded from environment/config (#221).
 * Each contract keeps its own topic handlers so events route to the correct domain parser.
 */
export function buildMultiContractRouter(
  contracts: MonitoredContract[],
  onUnmapped: UnmappedHandler,
): EventRouter {
  const router = new EventRouter(onUnmapped);
  for (const contract of contracts) {
    router.addContract(contract);
  }
  return router;
}
