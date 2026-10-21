/**
 * Oracle submission and dispute events in the live loop (#22).
 *
 * `oracle_submission`, `oracle_dispute` and `oracle_finalized` update `oracle_submissions` and the
 * market's `oracle_state`, then drop the cached market, so readers see the change within the
 * target window. The store and cache are injected, so the handlers run against PostgreSQL and
 * Redis in the indexer and against stubs in tests.
 */

import type { EventHandler } from "./event-router";
import type { RawContractEvent } from "./event-schema";

export type OracleState = "submitted" | "disputed" | "finalized";

export interface OracleStore {
  upsertSubmission(event: RawContractEvent, state: OracleState): Promise<void>;
  setMarketOracleState(marketId: number, state: OracleState): Promise<void>;
}

export interface MarketCache {
  invalidate(marketId: number): Promise<void>;
}

function marketIdOf(event: RawContractEvent): number {
  const value = event.value as { marketId?: unknown };
  if (typeof value?.marketId !== "number") {
    throw new Error(`oracle event ${event.txHash}:${event.eventIndex} has no marketId`);
  }
  return value.marketId;
}

/** Builds the handler for one oracle topic. */
export function oracleHandler(store: OracleStore, cache: MarketCache, state: OracleState): EventHandler {
  return async (event) => {
    const marketId = marketIdOf(event);
    await store.upsertSubmission(event, state);
    await store.setMarketOracleState(marketId, state);
    await cache.invalidate(marketId);
  };
}

/** The three oracle topics and the state each one sets. */
export const ORACLE_TOPICS: Record<string, OracleState> = {
  oracle_submission: "submitted",
  oracle_dispute: "disputed",
  oracle_finalized: "finalized",
};

/** Registers the three oracle topics on the live router (#22). */
export function registerOracleTopics(
  router: { register(topic: string, handler: EventHandler): void },
  store: OracleStore,
  cache: MarketCache,
): void {
  for (const [topic, state] of Object.entries(ORACLE_TOPICS)) {
    router.register(topic, oracleHandler(store, cache, state));
  }
}
