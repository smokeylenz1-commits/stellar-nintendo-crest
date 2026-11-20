/**
 * Politics and elections adapter (#44).
 *
 * Election results are only resolved when two independent official feeds declare the same winner.
 * Each feed's payload is normalised first: race names are trimmed and lower-cased, and the winner
 * is matched against the market's two candidates. A single feed, two feeds that disagree, or a
 * feed that names neither candidate, leaves the market for manual resolution.
 *
 * External feed fetches are cached in Redis (#229) with a short TTL so high-frequency dispute
 * checks do not trip provider rate limits. Cache keys are deterministic and include the provider
 * identifier plus the query parameters. Any Redis miss or error falls back to a direct fetch.
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

/** TTL for cached election feed responses, in seconds. */
export const ELECTION_FEED_TTL_SECONDS = 60;

/** Minimal Redis surface used for caching; compatible with ioredis / node-redis clients. */
export interface RedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
}

/** Fetches a single provider's election feed payload. */
export type ElectionFeedFetcher = (source: string, race: string) => Promise<ElectionFeedPayload>;

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Deterministic cache key: provider identifier + normalised query parameters. */
export function electionFeedCacheKey(source: string, race: string): string {
  return `oracle:politics:feed:${normalise(source)}:${normalise(race)}`;
}

/**
 * Fetches an election feed through Redis, falling back to a direct fetch on cache miss or Redis
 * failure. Successful direct fetches are written back to the cache with `ELECTION_FEED_TTL_SECONDS`.
 */
export async function fetchElectionFeedCached(
  source: string,
  race: string,
  fetcher: ElectionFeedFetcher,
  redis?: RedisCache,
): Promise<ElectionFeedPayload> {
  const key = electionFeedCacheKey(source, race);

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as ElectionFeedPayload;
    } catch {
      // Redis unavailable — fall through to a direct fetch.
    }
  }

  const payload = await fetcher(source, race);

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(payload), "EX", ELECTION_FEED_TTL_SECONDS);
    } catch {
      // Cache write failures must not break resolution.
    }
  }

  return payload;
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
