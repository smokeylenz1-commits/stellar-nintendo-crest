// indexer/src/router/registry.ts
//
// Unified event routing registry.
//
// This module is the SINGLE source of truth for mapping contract events
// (identified by a `domain` and `action`) to their handler functions.
// Both the main poller and the backfill runner MUST dispatch through
// `dispatch()` defined here so that routing logic never diverges again.

import { handleClaim } from "../handlers/claim";
import { handleFeeWithdrawn } from "../handlers/fee_withdrawn";
import { handleOracleSubmission } from "../handlers/oracle_submission";
import { handleTokenBurned } from "../handlers/token_burned";
import { handleCouncilVoted } from "../handlers/council_voted";
import { handleCouncilThresholdReached } from "../handlers/council_threshold_reached";

/**
 * A handler receives the raw event payload and performs the indexing work.
 * Handlers may be synchronous or asynchronous.
 */
export type EventHandler = (
  payload: Record<string, unknown>,
) => void | Promise<void>;

/**
 * A routing key is the composite of a contract `domain` and an `action`.
 */
export type RouteKey = `${string}:${string}`;

/**
 * Build a canonical route key from a domain and action.
 */
export function makeRouteKey(domain: string, action: string): RouteKey {
  return `${domain}:${action}`;
}

/**
 * The unified registry. Every known contract event MUST be registered here.
 *
 * Keys are of the form `${domain}:${action}`.
 */
export const registry: Record<RouteKey, EventHandler> = {
  // --- Claim domain -------------------------------------------------------
  "claim:claim": handleClaim,

  // --- Fee domain ---------------------------------------------------------
  "fee:fee_withdrawn": handleFeeWithdrawn,

  // --- Oracle domain ------------------------------------------------------
  "oracle:oracle_submission": handleOracleSubmission,

  // --- Token domain -------------------------------------------------------
  "token:token_burned": handleTokenBurned,

  // --- Council domain -----------------------------------------------------
  "council:council_voted": handleCouncilVoted,
  "council:council_threshold_reached": handleCouncilThresholdReached,
};

/**
 * Look up a handler for the given domain/action pair.
 * Returns `undefined` when no handler is registered.
 */
export function getHandler(
  domain: string,
  action: string,
): EventHandler | undefined {
  return registry[makeRouteKey(domain, action)];
}

/**
 * The list of registered route keys. Exposed for testability so that tests
 * can assert coverage of every known event type.
 */
export function registeredKeys(): RouteKey[] {
  return Object.keys(registry) as RouteKey[];
}

/**
 * Dispatch an event to its registered handler.
 *
 * When no handler is registered, a structured warning is emitted (instead of
 * silently dropping the event) so that orphaned events are surfaced in logs
 * and monitoring.
 *
 * @returns `true` if a handler was found and invoked, `false` otherwise.
 */
export async function dispatch(
  domain: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const key = makeRouteKey(domain, action);
  const handler = registry[key];

  if (!handler) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "unregistered_event",
        message: `No handler registered for event "${key}"`,
        domain,
        action,
        payload,
      }),
    );
    return false;
  }

  await handler(payload);
  return true;
}