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
