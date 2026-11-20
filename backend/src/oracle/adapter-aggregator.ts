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
 * Redis-backed response cache (#229).
 *
 * External price and sports providers rate-limit aggressively, so every upstream query is
 * memoized in Redis with a short TTL. Cache keys are deterministic (provider + query params)
 * and any Redis failure degrades gracefully to a direct upstream fetch.
 */

/** Minimal Redis surface the cache needs; compatible with ioredis / node-redis clients. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/** TTL for real-time price queries. */
export const PRICE_CACHE_TTL_SECONDS = 10;
/** TTL for sports game status queries. */
export const SPORTS_CACHE_TTL_SECONDS = 60;

/** Builds a deterministic cache key from a provider id and its query parameters. */
export function buildCacheKey(provider: string, params: Record<string, string | number | undefined>): string {
  const parts = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`);
  return `oracle:cache:${provider}:${parts.join("&")}`;
}

/**
 * Returns the cached JSON value for `key`, or runs `fetcher` and caches its result for `ttlSeconds`.
 * Redis read/write errors are swallowed so callers always fall back to a direct fetch.
 */
export async function cachedFetch<T>(
  redis: RedisLike | undefined,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {
      // cache read failed — fall through to a direct fetch
    }
  }

  const value = await fetcher();

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      // cache write failed — the fetched value is still returned
    }
  }

  return value;
}

/**
 * Sports outcome resolution (#228).
 *
 * Resolves professional sports / esports games (EPL, NBA, NFL, ...) into a binary market
 * outcome using official data providers (Sportsradar, TheRundown). Each provider is wrapped in
 * a `SportsDataProvider` adapter so the oracle can query game status, final score and the
 * official winner, and feed the result through the N-of-M consensus gate above.
 */

export type GameStatus = "scheduled" | "in_progress" | "final" | "postponed" | "cancelled";

export interface GameState {
  /** Provider game identifier. */
  gameId: string;
  status: GameStatus;
  /** Final scores, present once the game is `final`. */
  homeScore?: number;
  awayScore?: number;
  /** Official winner as reported by the provider, if any. */
  winner?: "home" | "away" | "draw";
}

/** A verified sports data source (Sportsradar, TheRundown, or a sandbox mock). */
export interface SportsDataProvider {
  readonly name: string;
  /** Fetches the current game state from the provider's verified endpoint. */
  getGameState(gameId: string): Promise<GameState>;
}

export interface SportsMarketTerms {
  /** Which side the market resolves YES for. */
  resolvesFor: "home" | "away";
  /** How a tie is treated. Defaults to `void` (market refunded / escalated). */
  onTie?: "void" | "no";
  /** How a postponed or cancelled game is treated. Defaults to `void`. */
  onPostponed?: "void" | "no";
  onCancelled?: "void" | "no";
}

export type SportsResolution =
  | { status: "resolved"; outcome: Outcome; game: GameState }
  | { status: "pending"; reason: string; game: GameState }
  | { status: "void"; reason: string; game: GameState };

/**
 * Maps a provider game state to a market outcome according to the market terms.
 * Postponed / cancelled / tie games follow the configured rules instead of resolving blindly.
 */
export function resolveSportsOutcome(game: GameState, terms: SportsMarketTerms): SportsResolution {
  if (game.status === "postponed") {
    const rule = terms.onPostponed ?? "void";
    return rule === "void"
      ? { status: "void", reason: "game postponed", game }
      : { status: "resolved", outcome: "NO", game };
  }
  if (game.status === "cancelled") {
    const rule = terms.onCancelled ?? "void";
    return rule === "void"
      ? { status: "void", reason: "game cancelled", game }
      : { status: "resolved", outcome: "NO", game };
  }
  if (game.status !== "final") {
    return { status: "pending", reason: `game is ${game.status}`, game };
  }

  const winner = game.winner ?? deriveWinner(game);
  if (winner === "draw") {
    const rule = terms.onTie ?? "void";
    return rule === "void"
      ? { status: "void", reason: "game ended in a tie", game }
      : { status: "resolved", outcome: "NO", game };
  }
  return { status: "resolved", outcome: winner === terms.resolvesFor ? "YES" : "NO", game };
}

function deriveWinner(game: GameState): "home" | "away" | "draw" | undefined {
  if (game.homeScore === undefined || game.awayScore === undefined) return undefined;
  if (game.homeScore === game.awayScore) return "draw";
  return game.homeScore > game.awayScore ? "home" : "away";
}

/**
 * Sportsradar adapter. Queries the official `schedules/{gameId}/summary` endpoint and maps the
 * response into a `GameState`.
 */
export class SportsradarAdapter implements SportsDataProvider {
  readonly name = "sportsradar";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.sportradar.com",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly redis?: RedisLike,
  ) {}

  async getGameState(gameId: string): Promise<GameState> {
    const key = buildCacheKey(this.name, { gameId });
    return cachedFetch(this.redis, key, SPORTS_CACHE_TTL_SECONDS, async () => {
      const url = `${this.baseUrl}/schedules/${encodeURIComponent(gameId)}/summary.json?api_key=${encodeURIComponent(this.apiKey)}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`sportsradar request failed: ${res.status}`);
      const body = (await res.json()) as {
        status?: string;
        home?: { points?: number };
        away?: { points?: number };
      };
      return {
        gameId,
        status: mapSportsradarStatus(body.status),
        homeScore: body.home?.points,
        awayScore: body.away?.points,
      };
    });
  }
}

function mapSportsradarStatus(status?: string): GameStatus {
  switch (status) {
    case "closed":
    case "complete":
      return "final";
    case "inprogress":
    case "live":
      return "in_progress";
    case "postponed":
      return "postponed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "scheduled";
  }
}

/**
 * TheRundown adapter. Queries the official `sports/{sport}/events/{gameId}` endpoint and maps
 * the response into a `GameState`.
 */
export class TheRundownAdapter implements SportsDataProvider {
  readonly name = "therundown";

  constructor(
    private readonly apiKey: string,
    private readonly sport: string,
    private readonly baseUrl = "https://therundown-therundown-v1.p.rapidapi.com",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly redis?: RedisLike,
  ) {}

  async getGameState(gameId: string): Promise<GameState> {
    const key = buildCacheKey(this.name, { sport: this.sport, gameId });
    return cachedFetch(this.redis, key, SPORTS_CACHE_TTL_SECONDS, async () => {
      const url = `${this.baseUrl}/sports/${encodeURIComponent(this.sport)}/events/${encodeURIComponent(gameId)}`;
      const res = await this.fetchImpl(url, {
        headers: { "X-RapidAPI-Key": this.apiKey },
      });
      if (!res.ok) throw new Error(`therundown request failed: ${res.status}`);
      const body = (await res.json()) as {
        event?: {
          status?: string;
          score?: { event_score_home?: number; event_score_away?: number };
        };
      };
      const event = body.event ?? {};
      return {
        gameId,
        status: mapTheRundownStatus(event.status),
        homeScore: event.score?.event_score_home,
        awayScore: event.score?.event_score_away,
      };
    });
  }
}

function mapTheRundownStatus(status?: string): GameStatus {
  switch (status) {
    case "STATUS_FINAL":
    case "STATUS_FINAL_OT":
      return "final";
    case "STATUS_IN_PROGRESS":
      return "in_progress";
    case "STATUS_POSTPONED":
      return "postponed";
    case "STATUS_CANCELED":
    case "STATUS_CANCELLED":
      return "cancelled";
    default:
      return "scheduled";
  }
}

/** In-memory mock adapter for end-to-end sandbox testing. */
export class MockSportsAdapter implements SportsDataProvider {
  readonly name = "mock";

  constructor(private readonly games: Record<string, GameState> = {}) {}

  setGameState(state: GameState): void {
    this.games[state.gameId] = state;
  }

  async getGameState(gameId: string): Promise<GameState> {
    const game = this.games[gameId];
    if (!game) throw new Error(`unknown mock game: ${gameId}`);
    return game;
  }
}
