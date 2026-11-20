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

/**
 * Resolves a market expiration timestamp to UTC Unix epoch seconds (#226).
 *
 * Accepts either a numeric epoch (seconds or milliseconds) or an ISO 8601 string that carries an
 * explicit UTC offset (`Z` or `±HH:MM`). Ambiguous local date strings without an offset are
 * rejected so that daylight saving transitions cannot shift a market's resolution window.
 */
export function resolveExpirationEpochSeconds(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("expiration timestamp must be a finite number");
    }
    // Values this large are milliseconds; normalize everything to epoch seconds.
    const seconds = Math.abs(value) >= 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    if (seconds < 0) {
      throw new Error("expiration timestamp must not be before the Unix epoch");
    }
    return seconds;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("expiration timestamp must not be empty");
  }

  // Require an explicit UTC offset: `Z` or `±HH:MM` (also accept `±HHMM`).
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    throw new Error(
      `ambiguous expiration timestamp "${value}": an explicit UTC offset (Z or ±HH:MM) is required`,
    );
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid expiration timestamp "${value}"`);
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 0) {
    throw new Error("expiration timestamp must not be before the Unix epoch");
  }
  return seconds;
}
