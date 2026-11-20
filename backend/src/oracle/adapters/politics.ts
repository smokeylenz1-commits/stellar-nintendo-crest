/**
 * Politics and elections adapter (#44).
 *
 * Election results are only resolved when two independent official feeds declare the same winner.
 * Each feed's payload is normalised first: race names are trimmed and lower-cased, and the winner
 * is matched against the market's two candidates. A single feed, two feeds that disagree, or a
 * feed that names neither candidate, leaves the market for manual resolution.
 */

import type { Outcome } from "../auto-submitter";

export interface ElectionFeedPayload {
  source: string;
  race: string;
  declaredWinner: string;
  certified: boolean;
}

export interface MarketCandidates {
  race: string;
  yesCandidate: string;
  noCandidate: string;
}

export const MIN_CONFIRMATIONS = 2;

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Maps a declared winner to the market outcome, or `undefined` when it matches neither candidate. */
export function outcomeFor(declaredWinner: string, market: MarketCandidates): Outcome | undefined {
  const winner = normalise(declaredWinner);
  if (winner === normalise(market.yesCandidate)) return "YES";
  if (winner === normalise(market.noCandidate)) return "NO";
  return undefined;
}

export type ElectionResult =
  | { status: "resolved"; outcome: Outcome; confirmedBy: string[] }
  | { status: "manual"; reason: string };

/** Requires `MIN_CONFIRMATIONS` certified feeds from distinct sources that agree on the outcome. */
export function resolveElection(market: MarketCandidates, feeds: ElectionFeedPayload[]): ElectionResult {
  const relevant = feeds.filter((f) => f.certified && normalise(f.race) === normalise(market.race));

  const bySource = new Map<string, Outcome>();
  for (const feed of relevant) {
    const outcome = outcomeFor(feed.declaredWinner, market);
    if (outcome && !bySource.has(feed.source)) {
      bySource.set(feed.source, outcome);
    }
  }

  const outcomes = [...new Set(bySource.values())];
  if (outcomes.length > 1) {
    return { status: "manual", reason: "certified feeds declare different winners" };
  }
  if (bySource.size < MIN_CONFIRMATIONS) {
    return { status: "manual", reason: `need ${MIN_CONFIRMATIONS} certified feeds from distinct sources` };
  }
  return { status: "resolved", outcome: outcomes[0], confirmedBy: [...bySource.keys()] };
}

/**
 * Multi-source price feed aggregation (#222).
 *
 * Prices are collected from independent oracles (Pyth, Band, Binance REST) and combined with a
 * trimmed median. Any source deviating by more than `MAX_DEVIATION` from the median is discarded
 * as an outlier before the verified median is submitted to the market contract with a proof payload.
 */

export const MIN_PRICE_SOURCES = 3;
export const MAX_DEVIATION = 0.03;

export interface PriceSource {
  source: string;
  price: number;
}

export interface PriceProofPayload {
  median: number;
  sources: PriceSource[];
  rejected: PriceSource[];
  timestamp: number;
}

export type AggregationResult =
  | { status: "verified"; median: number; proof: PriceProofPayload }
  | { status: "manual"; reason: string };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * Aggregates prices from independent sources, rejecting outliers beyond `MAX_DEVIATION` of the
 * median. Requires at least `MIN_PRICE_SOURCES` valid sources to produce a verified median.
 */
export function aggregatePrices(prices: PriceSource[], timestamp = Date.now()): AggregationResult {
  const valid = prices.filter((p) => Number.isFinite(p.price) && p.price > 0);
  if (valid.length < MIN_PRICE_SOURCES) {
    return { status: "manual", reason: `need ${MIN_PRICE_SOURCES} valid price sources` };
  }

  const rawMedian = median(valid.map((p) => p.price));
  const accepted: PriceSource[] = [];
  const rejected: PriceSource[] = [];
  for (const p of valid) {
    if (Math.abs(p.price - rawMedian) / rawMedian <= MAX_DEVIATION) {
      accepted.push(p);
    } else {
      rejected.push(p);
    }
  }

  if (accepted.length < MIN_PRICE_SOURCES) {
    return { status: "manual", reason: `only ${accepted.length} sources within ${MAX_DEVIATION * 100}% of median` };
  }

  const verifiedMedian = median(accepted.map((p) => p.price));
  return {
    status: "verified",
    median: verifiedMedian,
    proof: { median: verifiedMedian, sources: accepted, rejected, timestamp },
  };
}
