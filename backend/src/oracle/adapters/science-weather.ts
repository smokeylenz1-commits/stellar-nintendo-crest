/**
 * Science, tech and weather adapter (#45).
 *
 * Resolves temperature-threshold markets from a weather observation, and launch markets from a
 * launch record. A rescheduled or cancelled event yields no outcome, so the market is left for
 * manual handling and is never resolved from a guess. The source payloads are normalised first.
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
