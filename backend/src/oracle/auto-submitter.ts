/**
 * Auto-submission worker for expired markets (#36).
 *
 * For an expired market, the worker picks the data adapters for the market's category, asks
 * each one for an outcome, and submits the outcome only when the adapters agree. The submission
 * posts the required submitter bond from the protocol hot wallet. An adapter error is recorded
 * and does not stop the other adapters.
 */

export type Outcome = "YES" | "NO";

export interface Adapter {
  name: string;
  fetchOutcome(marketId: number): Promise<Outcome>;
}

/** Adapters used for each market category. */
export const ADAPTERS_BY_CATEGORY: Record<string, string[]> = {
  crypto: ["binance", "coinmarketcap", "oddsapi"],
  sports: ["oddsapi"],
};

export interface SubmitterDeps {
  adaptersFor(category: string): Adapter[];
  submitOutcome(marketId: number, outcome: Outcome, bondXlm: number): Promise<void>;
  bondXlm: number;
  onError(adapter: string, err: unknown): void;
}

export type SubmitResult =
  | { submitted: true; outcome: Outcome }
  | { submitted: false; reason: string };

/** Asks every adapter, and returns the outcome only when all of the answers agree. */
export async function submitExpiredMarket(
  marketId: number,
  category: string,
  deps: SubmitterDeps,
): Promise<SubmitResult> {
  const adapters = deps.adaptersFor(category);
  if (adapters.length === 0) {
    return { submitted: false, reason: `no adapters for category ${category}` };
  }

  const answers: Outcome[] = [];
  for (const adapter of adapters) {
    try {
      answers.push(await adapter.fetchOutcome(marketId));
    } catch (err) {
      deps.onError(adapter.name, err);
    }
  }

  if (answers.length === 0) {
    return { submitted: false, reason: "every adapter failed" };
  }
  const agreed = answers.every((a) => a === answers[0]);
  if (!agreed) {
    return { submitted: false, reason: "adapters disagree" };
  }

  await deps.submitOutcome(marketId, answers[0], deps.bondXlm);
  return { submitted: true, outcome: answers[0] };
}

/**
 * Multi-source price feed aggregator (#222).
 *
 * Queries independent price sources (Pyth, Band, Binance REST), computes a trimmed median,
 * rejects any source deviating more than 3% from the median, and submits the verified median
 * to the market contract together with a proof payload describing the contributing sources.
 */

export interface PriceSource {
  name: string;
  fetchPrice(asset: string): Promise<number>;
}

export interface PriceProof {
  asset: string;
  median: number;
  sources: { name: string; price: number }[];
  rejected: { name: string; price: number; deviation: number }[];
  timestamp: number;
}

export interface AggregatorDeps {
  sources: PriceSource[];
  submitPrice(asset: string, median: number, proof: PriceProof): Promise<void>;
  onError(source: string, err: unknown): void;
}

export type AggregateResult =
  | { submitted: true; median: number; proof: PriceProof }
  | { submitted: false; reason: string };

/** Maximum allowed fractional deviation from the median before a source is rejected. */
export const MAX_DEVIATION = 0.03;

/** Minimum number of independent sources required to aggregate. */
export const MIN_SOURCES = 3;

/** Computes the median of a non-empty list of numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Aggregates prices from the configured sources for `asset`, rejects outliers beyond
 * MAX_DEVIATION from the median, and submits the verified median with a proof payload.
 */
export async function aggregateAndSubmit(
  asset: string,
  deps: AggregatorDeps,
): Promise<AggregateResult> {
  const collected: { name: string; price: number }[] = [];
  for (const source of deps.sources) {
    try {
      const price = await source.fetchPrice(asset);
      if (Number.isFinite(price) && price > 0) {
        collected.push({ name: source.name, price });
      }
    } catch (err) {
      deps.onError(source.name, err);
    }
  }

  if (collected.length < MIN_SOURCES) {
    return {
      submitted: false,
      reason: `need at least ${MIN_SOURCES} sources, got ${collected.length}`,
    };
  }

  const med = median(collected.map((c) => c.price));
  const accepted: { name: string; price: number }[] = [];
  const rejected: { name: string; price: number; deviation: number }[] = [];
  for (const entry of collected) {
    const deviation = Math.abs(entry.price - med) / med;
    if (deviation > MAX_DEVIATION) {
      rejected.push({ ...entry, deviation });
    } else {
      accepted.push(entry);
    }
  }

  if (accepted.length < MIN_SOURCES) {
    return {
      submitted: false,
      reason: `only ${accepted.length} sources within ${MAX_DEVIATION * 100}% of median`,
    };
  }

  const verifiedMedian = median(accepted.map((a) => a.price));
  const proof: PriceProof = {
    asset,
    median: verifiedMedian,
    sources: accepted,
    rejected,
    timestamp: Date.now(),
  };

  await deps.submitPrice(asset, verifiedMedian, proof);
  return { submitted: true, median: verifiedMedian, proof };
}
