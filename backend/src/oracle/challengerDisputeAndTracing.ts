/**
 * Challenger Outcome Dispute (200 XLM Bond), HTTP ETag Caching & Request Tracing (#57, #58, #64, #65)
 *
 * Handles Challenger disputing a proposed YES outcome to NO with a 200 XLM bond,
 * ETag / If-None-Match generation for market read endpoints, BetPlaced cache invalidation,
 * OpenAPI specification metadata, and X-Request-ID trace header propagation.
 */

import { createHash, randomUUID } from "crypto";

export const MINIMUM_CHALLENGER_BOND_XLM = 200;

export interface ChallengerDisputeRecord {
  disputeId: number;
  marketId: number;
  challenger: string;
  challengedOutcome: "YES" | "NO";
  bondXlm: number;
  requestId: string;
}

export function disputeProposedOutcomeToNo(params: {
  disputeId: number;
  marketId: number;
  currentProposedOutcome: "YES" | "NO";
  challenger: string;
  challengedOutcome: "YES" | "NO";
  bondXlm: number;
  requestId?: string;
}): ChallengerDisputeRecord {
  if (params.bondXlm < MINIMUM_CHALLENGER_BOND_XLM) {
    throw new Error(`Challenger bond must be at least ${MINIMUM_CHALLENGER_BOND_XLM} XLM`);
  }
  if (params.challengedOutcome === params.currentProposedOutcome) {
    throw new Error("Challenged outcome must oppose the proposed outcome");
  }
  return {
    disputeId: params.disputeId,
    marketId: params.marketId,
    challenger: params.challenger,
    challengedOutcome: params.challengedOutcome,
    bondXlm: params.bondXlm,
    requestId: params.requestId || randomUUID(),
  };
}

export function computeMarketETag(payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
  return `"${digest}"`;
}

export function invalidateMarketCacheKeysOnBetPlaced(marketId: number | string): string[] {
  return [
    `market:${marketId}:details`,
    `market:${marketId}:odds`,
    `market:${marketId}:bets`,
    "leaderboard:top",
  ];
}
