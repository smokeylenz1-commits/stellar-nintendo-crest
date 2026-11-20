/**
 * N-of-M adapter consensus gate (#38).
 *
 * An outcome is submitted only when at least `required` of the adapters agree on it. A single
 * source cannot submit by itself. When the answers split without reaching the threshold, the
 * market is escalated to council review instead of being submitted automatically.
 *
 * Also hosts the multi-source price aggregator (#222): prices are collected from independent
 * oracles (Pyth, Band, Binance), a trimmed median is computed, and sources deviating by more
 * than the configured tolerance from the median are rejected before submission.
 */

import type { Outcome } from "./auto-submitter";

export interface AggregateOptions {
  /** How many adapters must agree (N in N-of-M). Defaults to 2. */
  required?: number;
}

export type AggregateResult =
  | { status: "agreed"; outcome: Outcome; agreeing: number }
  | { status: "escalate"; reason: string; tally: Record<Outcome, number> };

/** Counts the answers and returns an outcome only when `required` of them match. */
export function aggregateOutcomes(answers: Outcome[], options: AggregateOptions = {}): AggregateResult {
  const required = options.required ?? 2;
  if (required < 2) {
    throw new Error("a consensus gate needs at least two agreeing sources");
  }

  const tally: Record<Outcome, number> = { YES: 0, NO: 0 };
  for (const a of answers) tally[a]++;

  for (const outcome of ["YES", "NO"] as Outcome[]) {
    if (tally[outcome] >= required) {
      return { status: "agreed", outcome, agreeing: tally[outcome] };
    }
  }
  return {
    status: "escalate",
    reason: answers.length < required ? "too few adapter answers" : "adapters disagree",
    tally,
  };
}

/** A single price observation from one independent oracle source. */
export interface PriceSource {
  /** Stable identifier for the source, e.g. "pyth", "band", "binance". */
  name: string;
  /** Observed price in quote units. */
  price: number;
  /** Unix timestamp (ms) at which the price was observed. */
  timestamp: number;
}

/** Fetches the current price from a single oracle source. */
export type PriceFetcher = () => Promise<PriceSource>;

export interface PriceAggregatorOptions {
  /** Minimum number of independent sources required to produce a result. Defaults to 3. */
  minSources?: number;
  /** Maximum fractional deviation from the median before a source is rejected. Defaults to 0.03 (3%). */
  maxDeviation?: number;
}

export interface PriceProofPayload {
  /** Verified median price after outlier rejection. */
  median: number;
  /** Sources whose prices were accepted into the median. */
  accepted: PriceSource[];
  /** Sources rejected as statistical outliers, with their deviation from the median. */
  rejected: Array<PriceSource & { deviation: number }>;
  /** Number of independent sources consulted. */
  sourceCount: number;
  /** Unix timestamp (ms) at which the aggregation was produced. */
  timestamp: number;
}

export type PriceAggregateResult =
  | { status: "verified"; proof: PriceProofPayload }
  | { status: "rejected"; reason: string };

/** Computes the median of a numeric list (average of the two middle values for even lengths). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Multi-source price feed aggregator (#222).
 *
 * Queries independent oracles, computes a trimmed median, rejects sources deviating by more
 * than `maxDeviation` from the median, and returns a proof payload for the market contract.
 */
export class PriceAggregator {
  private readonly fetchers: PriceFetcher[];
  private readonly minSources: number;
  private readonly maxDeviation: number;

  constructor(fetchers: PriceFetcher[], options: PriceAggregatorOptions = {}) {
    this.fetchers = fetchers;
    this.minSources = options.minSources ?? 3;
    this.maxDeviation = options.maxDeviation ?? 0.03;
  }

  /** Collects prices from all sources, tolerating individual source failures. */
  private async collect(): Promise<PriceSource[]> {
    const settled = await Promise.allSettled(this.fetchers.map((fetch) => fetch()));
    const prices: PriceSource[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled" && Number.isFinite(result.value.price) && result.value.price > 0) {
        prices.push(result.value);
      }
    }
    return prices;
  }

  /** Aggregates prices and returns a verified median with a proof payload, or a rejection. */
  async aggregate(): Promise<PriceAggregateResult> {
    const prices = await this.collect();
    if (prices.length < this.minSources) {
      return {
        status: "rejected",
        reason: `need at least ${this.minSources} independent sources, got ${prices.length}`,
      };
    }

    const center = median(prices.map((p) => p.price));
    const accepted: PriceSource[] = [];
    const rejected: Array<PriceSource & { deviation: number }> = [];
    for (const source of prices) {
      const deviation = Math.abs(source.price - center) / center;
      if (deviation > this.maxDeviation) {
        rejected.push({ ...source, deviation });
      } else {
        accepted.push(source);
      }
    }

    if (accepted.length < this.minSources) {
      return {
        status: "rejected",
        reason: `only ${accepted.length} sources within ${this.maxDeviation * 100}% of median`,
      };
    }

    const verifiedMedian = median(accepted.map((p) => p.price));
    return {
      status: "verified",
      proof: {
        median: verifiedMedian,
        accepted,
        rejected,
        sourceCount: prices.length,
        timestamp: Date.now(),
      },
    };
  }
}
