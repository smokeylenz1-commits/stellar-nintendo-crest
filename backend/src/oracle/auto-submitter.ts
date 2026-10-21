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
