/**
 * Science, tech and weather adapter (#45).
 *
 * Resolves temperature-threshold markets from a weather observation, and launch markets from a
 * launch record. A rescheduled or cancelled event yields no outcome, so the market is left for
 * manual handling and is never resolved from a guess. The source payloads are normalised first.
 *
 * All timestamps are evaluated strictly against UTC Unix epoch seconds (#226): ambiguous local
 * date strings without an explicit UTC offset are rejected rather than guessed.
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

/** Matches an ISO 8601 date-time that carries an explicit UTC offset (Z or ±HH:MM). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Resolves a timestamp to UTC Unix epoch seconds.
 *
 * Accepts numeric epoch seconds or an ISO 8601 string with an explicit UTC offset. Ambiguous
 * local timezone strings (no offset) and invalid/out-of-range dates are rejected with a clear
 * error so market expiration comparisons never rely on a guessed timezone.
 */
export function resolveUtcEpochSeconds(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`invalid epoch seconds: ${value}`);
    }
    return value;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) {
      throw new Error(`invalid epoch seconds: ${value}`);
    }
    return seconds;
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

/** Resolves a temperature-threshold market from one observation. */
export function resolveTemperature(market: WeatherMarket, obs: TemperatureObservation): ScienceResult {
  if (!Number.isFinite(obs.celsius)) {
    return { status: "manual", reason: "observation is not a number" };
  }
  try {
    resolveUtcEpochSeconds(obs.observedAt);
  } catch (err) {
    return { status: "manual", reason: (err as Error).message };
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
