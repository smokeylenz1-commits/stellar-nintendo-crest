/**
 * N-of-M adapter consensus gate (#38).
 *
 * An outcome is submitted only when at least `required` of the adapters agree on it. A single
 * source cannot submit by itself. When the answers split without reaching the threshold, the
 * market is escalated to council review instead of being submitted automatically.
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
