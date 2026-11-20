/**
 * Science, tech and weather adapter (#45).
 *
 * Resolves temperature-threshold markets from a weather observation, and launch markets from a
 * launch record. A rescheduled or cancelled event yields no outcome, so the market is left for
 * manual handling and is never resolved from a guess. The source payloads are normalised first.
 *
 * External weather/launch lookups are cached in Redis (#229) with short TTLs to avoid hitting
 * provider rate limits. Cache keys are deterministic and include the provider identifier plus the
 * query parameters. Any Redis miss or error falls back to a direct upstream fetch.
 */

import type { Outcome } from "../auto-submitter";

export type WeatherMarket = {
  kind: "temperature_above";
  thresholdC: number;
};

export type LaunchMarket = {
  kind: "launch_success";
};

export type ScienceMarket = WeatherMarket | LaunchMarket;

export interface TemperatureObservation {
  station: string;
  celsius: number;
  observedAt: string;
}

export interface LaunchRecord {
  mission: string;
  status: "success" | "failure" | "scrubbed" | "rescheduled" | "cancelled";
}

export type ScienceResult =
  | { status: "resolved"; outcome: Outcome }
  | { status: "manual"; reason: string };

/** Minimal Redis surface used for caching; compatible with ioredis / node-redis clients. */
export interface RedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/** Real-time weather observations are cached briefly. */
export const WEATHER_CACHE_TTL_SECONDS = 10;
/** Launch status changes slowly, so it can be cached longer. */
export const LAUNCH_CACHE_TTL_SECONDS = 60;

/** Builds a deterministic cache key from a provider id and its query parameters. */
export function buildCacheKey(provider: string, params: Record<string, string | number>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join("&");
  return `oracle:${provider}:${sorted}`;
}

/**
 * Reads a cached value, or fetches it upstream and caches the result. Any Redis failure (get or
 * set) is swallowed so the caller always gets a value via a direct fetch.
 */
async function cachedFetch<T>(
  cache: RedisCache | undefined,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (cache) {
    try {
      const hit = await cache.get(key);
      if (hit !== null) {
        return JSON.parse(hit) as T;
      }
    } catch {
      // Redis unavailable — fall through to a direct fetch.
    }
  }

  const value = await fetcher();

  if (cache) {
    try {
      await cache.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      // Caching is best-effort; ignore write failures.
    }
  }

  return value;
}

/** Fetches a temperature observation, cached for 10s. */
export async function fetchTemperatureObservation(
  station: string,
  fetcher: () => Promise<TemperatureObservation>,
  cache?: RedisCache,
): Promise<TemperatureObservation> {
  const key = buildCacheKey("weather", { station });
  return cachedFetch(cache, key, WEATHER_CACHE_TTL_SECONDS, fetcher);
}

/** Fetches a launch record, cached for 60s. */
export async function fetchLaunchRecord(
  mission: string,
  fetcher: () => Promise<LaunchRecord>,
  cache?: RedisCache,
): Promise<LaunchRecord> {
  const key = buildCacheKey("launch", { mission });
  return cachedFetch(cache, key, LAUNCH_CACHE_TTL_SECONDS, fetcher);
}

/** Resolves a temperature-threshold market from one observation. */
export function resolveTemperature(market: WeatherMarket, obs: TemperatureObservation): ScienceResult {
  if (!Number.isFinite(obs.celsius)) {
    return { status: "manual", reason: "observation is not a number" };
  }
  return {
    status: "resolved",
    outcome: obs.celsius > market.thresholdC ? "YES" : "NO",
  };
}

/** Resolves a launch market. Scrubbed, rescheduled or cancelled launches are never resolved here. */
export function resolveLaunch(record: LaunchRecord): ScienceResult {
  switch (record.status) {
    case "success":
      return { status: "resolved", outcome: "YES" };
    case "failure":
      return { status: "resolved", outcome: "NO" };
    default:
      return { status: "manual", reason: `launch was ${record.status}` };
  }
}
