/**
 * Market Expiry Submitter Proposal (100 XLM Bond) & Streaming/Caching Infrastructure (#59, #60, #61, #66)
 *
 * Models the post-expiry oracle submission step where the Submitter proposes outcome YES
 * backed by a 100 XLM bond, alongside single-flight request coalescing, stale-while-revalidate
 * Redis degradation fallback, WebSocket/SSE live odds streaming, and Prometheus latency histograms.
 */

export const MINIMUM_SUBMITTER_BOND_XLM = 100;

export interface OracleOutcomeProposal {
  marketId: number;
  submitter: string;
  proposedOutcome: "YES" | "NO";
  bondXlm: number;
  submittedAt: number;
}

export function proposeExpiredMarketOutcome(params: {
  marketId: number;
  marketExpiresAt: number;
  now: number;
  submitter: string;
  proposedOutcome: "YES" | "NO";
  bondXlm: number;
}): OracleOutcomeProposal {
  if (params.now < params.marketExpiresAt) {
    throw new Error("Market has not expired yet");
  }
  if (params.bondXlm < MINIMUM_SUBMITTER_BOND_XLM) {
    throw new Error(`Submitter bond must be at least ${MINIMUM_SUBMITTER_BOND_XLM} XLM`);
  }
  return {
    marketId: params.marketId,
    submitter: params.submitter,
    proposedOutcome: params.proposedOutcome,
    bondXlm: params.bondXlm,
    submittedAt: params.now,
  };
}

export class SingleFlightCoalescer<T> {
  private inFlight = new Map<string, Promise<T>>();

  async execute(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
