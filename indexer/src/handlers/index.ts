/**
 * Handler barrel module.
 *
 * This file intentionally contains NO routing or dispatch logic. All event
 * routing lives in a single source of truth: `indexer/src/router/registry.ts`.
 *
 * These re-exports exist purely for convenience so that individual handler
 * modules can be imported from a single location. The registry is the only
 * place that maps `(domain, action)` pairs to handlers.
 */

export { handleClaim } from './claim';
export { handleFeeWithdrawn } from './fee_withdrawn';
export { handleOracleSubmission } from './oracle_submission';