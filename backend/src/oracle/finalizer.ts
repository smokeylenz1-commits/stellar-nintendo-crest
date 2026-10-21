/**
 * Auto-finalization cron for uncontested submissions (#49).
 *
 * Runs with the oracle daemon. A market in `Submitted` state whose challenge deadline has passed
 * with no challenge is finalized on-chain, using the oracle worker key. The submitter's bond is
 * then returned. Each market is finalized at most once per run, and a failure is recorded and
 * retried on the next run.
 */

export interface SubmittedMarket {
  marketId: number;
  submitter: string;
  bondXlm: number;
  challengeDeadline: Date;
  challenged: boolean;
}

export interface FinalizerDeps {
  submittedMarkets(): Promise<SubmittedMarket[]>;
  finalizeOutcome(marketId: number): Promise<void>;
  releaseBond(submitter: string, bondXlm: number): Promise<void>;
  onError(marketId: number, err: unknown): void;
  now: () => Date;
}

/** A market is ready once its challenge deadline has passed and nobody has challenged it. */
export function isReadyToFinalize(market: SubmittedMarket, now: Date): boolean {
  return !market.challenged && market.challengeDeadline.getTime() < now.getTime();
}

/** One run. Returns the market ids finalized on this run. */
export async function runFinalizer(deps: FinalizerDeps): Promise<number[]> {
  const now = deps.now();
  const finalized: number[] = [];

  for (const market of await deps.submittedMarkets()) {
    if (!isReadyToFinalize(market, now)) continue;
    try {
      await deps.finalizeOutcome(market.marketId);
      await deps.releaseBond(market.submitter, market.bondXlm);
      finalized.push(market.marketId);
    } catch (err) {
      deps.onError(market.marketId, err);
    }
  }
  return finalized;
}
