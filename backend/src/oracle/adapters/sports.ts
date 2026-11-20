/**
 * Sports and esports outcome adapter (#228).
 *
 * Resolves professional games (EPL, NBA, NFL, esports) from official sports data providers.
 * Each provider is normalised into a `SportsFeedPayload`; the adapter then applies market terms
 * for postponed, cancelled, and tie games before declaring a winner.
 *
 * A game is only resolved when at least `MIN_CONFIRMATIONS` verified feeds from distinct sources
 * agree on the final state. A single feed, disagreeing feeds, or an unresolved game state leaves
 * the market for manual resolution.
 */

import type { Outcome } from "../auto-submitter";

export type GameStatus = "scheduled" | "in_progress" | "final" | "postponed" | "cancelled";

export interface SportsFeedPayload {
  source: string;
  gameId: string;
  status: GameStatus;
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
  verified: boolean;
}

export interface SportsMarket {
  gameId: string;
  yesTeam: string;
  noTeam: string;
  /** How the market treats a tie final score. */
  tieRule: "void" | "yes" | "no";
  /** How the market treats a postponed or cancelled game. */
  abandonedRule: "void" | "manual";
}

export const MIN_CONFIRMATIONS = 2;

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Maps a final score to the market outcome, or `undefined` when it matches neither team. */
export function outcomeForScore(
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number,
  market: SportsMarket,
): Outcome | undefined {
  if (homeScore === awayScore) return undefined;
  const winner = homeScore > awayScore ? homeTeam : awayTeam;
  if (normalise(winner) === normalise(market.yesTeam)) return "YES";
  if (normalise(winner) === normalise(market.noTeam)) return "NO";
  return undefined;
}

export type SportsResult =
  | { status: "resolved"; outcome: Outcome; confirmedBy: string[] }
  | { status: "void"; reason: string }
  | { status: "manual"; reason: string };

/** Resolves a sports market from verified provider feeds, applying market terms for edge cases. */
export function resolveSportsGame(market: SportsMarket, feeds: SportsFeedPayload[]): SportsResult {
  const relevant = feeds.filter((f) => f.verified && f.gameId === market.gameId);

  if (relevant.length === 0) {
    return { status: "manual", reason: "no verified feeds for game" };
  }

  const abandoned = relevant.find((f) => f.status === "postponed" || f.status === "cancelled");
  if (abandoned) {
    if (market.abandonedRule === "void") {
      return { status: "void", reason: `game ${abandoned.status}` };
    }
    return { status: "manual", reason: `game ${abandoned.status}` };
  }

  const finals = relevant.filter(
    (f) => f.status === "final" && f.homeScore !== undefined && f.awayScore !== undefined,
  );
  if (finals.length === 0) {
    return { status: "manual", reason: "game not final" };
  }

  const bySource = new Map<string, Outcome | "tie">();
  for (const feed of finals) {
    if (feed.homeScore === feed.awayScore) {
      if (!bySource.has(feed.source)) bySource.set(feed.source, "tie");
      continue;
    }
    const outcome = outcomeForScore(feed.homeTeam, feed.awayTeam, feed.homeScore!, feed.awayScore!, market);
    if (outcome && !bySource.has(feed.source)) bySource.set(feed.source, outcome);
  }

  const values = [...new Set(bySource.values())];
  if (values.length > 1) {
    return { status: "manual", reason: "verified feeds disagree on final state" };
  }
  if (bySource.size < MIN_CONFIRMATIONS) {
    return { status: "manual", reason: `need ${MIN_CONFIRMATIONS} verified feeds from distinct sources` };
  }

  const agreed = values[0];
  if (agreed === "tie") {
    if (market.tieRule === "void") return { status: "void", reason: "final score was a tie" };
    return { status: "resolved", outcome: market.tieRule === "yes" ? "YES" : "NO", confirmedBy: [...bySource.keys()] };
  }
  return { status: "resolved", outcome: agreed, confirmedBy: [...bySource.keys()] };
}

/** Provider adapter contract for sports data sources. */
export interface SportsProvider {
  readonly name: string;
  fetchGame(gameId: string): Promise<SportsFeedPayload>;
}

/** Sportsradar adapter — queries the official game summary endpoint. */
export class SportsradarAdapter implements SportsProvider {
  readonly name = "sportsradar";

  constructor(private readonly apiKey: string, private readonly baseUrl = "https://api.sportradar.com") {}

  async fetchGame(gameId: string): Promise<SportsFeedPayload> {
    const res = await fetch(`${this.baseUrl}/games/${encodeURIComponent(gameId)}/summary.json?api_key=${this.apiKey}`);
    if (!res.ok) throw new Error(`sportsradar: ${res.status}`);
    const data = (await res.json()) as any;
    const status: GameStatus = data.status === "closed" ? "final" : data.status === "postponed" ? "postponed" : data.status === "cancelled" ? "cancelled" : "in_progress";
    return {
      source: this.name,
      gameId,
      status,
      homeTeam: data.home?.name ?? "",
      awayTeam: data.away?.name ?? "",
      homeScore: data.home?.points,
      awayScore: data.away?.points,
      verified: true,
    };
  }
}

/** TheRundown adapter — queries the official game endpoint. */
export class TheRundownAdapter implements SportsProvider {
  readonly name = "therundown";

  constructor(private readonly apiKey: string, private readonly baseUrl = "https://therundown-therundown-v1.p.rapidapi.com") {}

  async fetchGame(gameId: string): Promise<SportsFeedPayload> {
    const res = await fetch(`${this.baseUrl}/events/${encodeURIComponent(gameId)}`, {
      headers: { "X-RapidAPI-Key": this.apiKey },
    });
    if (!res.ok) throw new Error(`therundown: ${res.status}`);
    const data = (await res.json()) as any;
    const event = data.event ?? data;
    const status: GameStatus = event.event_status === "Final" ? "final" : event.event_status === "Postponed" ? "postponed" : event.event_status === "Canceled" ? "cancelled" : "in_progress";
    return {
      source: this.name,
      gameId,
      status,
      homeTeam: event.teams?.[0]?.name ?? "",
      awayTeam: event.teams?.[1]?.name ?? "",
      homeScore: event.score?.score_home,
      awayScore: event.score?.score_away,
      verified: true,
    };
  }
}

/** Mock adapter for end-to-end sandbox testing. */
export class MockSportsAdapter implements SportsProvider {
  readonly name = "mock";

  constructor(private readonly payload: SportsFeedPayload) {}

  async fetchGame(gameId: string): Promise<SportsFeedPayload> {
    return { ...this.payload, gameId };
  }
}
