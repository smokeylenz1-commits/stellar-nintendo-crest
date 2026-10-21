/**
 * @deprecated This module is a thin compatibility shim.
 *
 * The single source of truth for event routing now lives in
 * `indexer/src/router/registry.ts`. All dispatch logic has been consolidated
 * there to guarantee exactly one dispatcher exists in the codebase.
 *
 * Do not add routing logic here. Import from the registry instead.
 */

export {
  // Core registry surface
  EventRegistry,
  eventRegistry,
  registerEventHandler,
  getEventHandler,
  hasEventHandler,
  listRegisteredEvents,
  dispatchEvent,
  // Types
  type EventHandler,
  type EventHandlerContext,
  type EventKey,
  type DispatchResult,
  type UnregisteredEventWarning,
} from './router/registry.js';

/**
 * Backwards-compatible alias for `dispatchEvent`.
 *
 * @deprecated Use `dispatchEvent` from `./router/registry.js` directly.
 */
export { dispatchEvent as routeEvent } from './router/registry.js';