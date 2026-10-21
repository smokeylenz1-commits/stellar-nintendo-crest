/**
 * Auto-challenge worker for third-party submissions (#37).
 *
 * For each pending submission inside the challenge window, the worker queries the adapters for
 * the market's category. If the answers diverge from the submitted outcome, it posts a challenge
 * with the disputer bond and alerts operations. A submission that matches, or that no adapter can
 * verify, is left alone.
 */

import type { Adapter, Outcome } from "./auto-submitter";

export interface PendingSubmission {
  marketId: number;
  category: string;
  submittedOutcome: Outcome;
  submittedAt: Date;
}

export interface ChallengerDeps {
  adaptersFor(category: string): Adapter[];
  challengeOutcome(marketId: number, bondXlm: number): Promise<void>;
  alertOps(message: string, fields: Record<string, unknown>): void;
  bondXlm: number;
  now: () => Date;
  challengeWindowMs: number;
}

export type ChallengeDecision =
  | { action: "challenged"; marketId: number }
  | { action: "matches" | "no_answers" | "expired"; marketId: number };

/** Decides what to do with one pending submission, and acts on it. */
export async function reviewSubmission(sub: PendingSubmission, deps: ChallengerDeps): Promise<ChallengeDecision> {
  const elapsed = deps.now().getTime() - sub.submittedAt.getTime();
  if (elapsed > deps.challengeWindowMs) {
    return { action: "expired", marketId: sub.marketId };
  }

  const answers: Outcome[] = [];
  for (const adapter of deps.adaptersFor(sub.category)) {
    try {
      answers.push(await adapter.fetchOutcome(sub.marketId));
    } catch {
      // An adapter that cannot answer is ignored. The others still decide.
    }
  }
  if (answers.length === 0) {
    return { action: "no_answers", marketId: sub.marketId };
  }

  const diverges = answers.some((a) => a !== sub.submittedOutcome);
  if (!diverges) {
    return { action: "matches", marketId: sub.marketId };
  }

  await deps.challengeOutcome(sub.marketId, deps.bondXlm);
  deps.alertOps("Third-party outcome challenged", {
    marketId: sub.marketId,
    submittedOutcome: sub.submittedOutcome,
    adapterAnswers: answers,
  });
  return { action: "challenged", marketId: sub.marketId };
}
