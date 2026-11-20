/**
 * Politics and elections adapter (#44).
 *
 * Election results are only resolved when two independent official feeds declare the same winner.
 * Each feed's payload is normalised first: race names are trimmed and lower-cased, and the winner
 * is matched against the market's two candidates. A single feed, two feeds that disagree, or a
 * feed that names neither candidate, leaves the market for manual resolution.
 *
 * Expiration timestamps (#226) are resolved strictly to UTC Unix epoch seconds: ISO 8601 strings
 * must carry an explicit UTC offset (`Z` or `±HH:MM`) and numeric epoch seconds are accepted as-is.
 * Ambiguous local time strings and invalid/out-of-range dates are rejected.
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

/** ISO 8601 with an explicit UTC offset: `Z` or `±HH:MM` (optionally `±HHMM`). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Resolves a market expiration timestamp to UTC Unix epoch seconds.
 *
 * Accepts numeric epoch seconds or ISO 8601 strings with an explicit UTC offset. Rejects
 * ambiguous local time strings (no offset) and invalid/out-of-range dates so market resolution
 * comparisons never drift across timezones or daylight saving transitions.
 */
export function resolveExpirationUtc(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`invalid epoch seconds: ${value}`);
    }
    return value;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return resolveExpirationUtc(Number(trimmed));
  }
  if (!ISO_WITH_OFFSET.test(trimmed)) {
    throw new Error(`ambiguous or invalid timestamp (explicit UTC offset required): ${value}`);
  }

  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return Math.floor(ms / 1000);
}

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
