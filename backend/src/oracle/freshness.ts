/**
 * Freshness check and failover for adapter responses (#46).
 *
 * A response is usable only when its `last_updated` timestamp is within the freshness window
 * (10 minutes by default). Stale responses are discarded. Adapters are tried in order, so the
 * secondary is used when the primary is stale. If every adapter is stale, nothing is submitted.
 */

export const FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

export interface TimedResponse<T> {
  adapter: string;
  value: T;
  lastUpdated: string;
}

export type FreshnessResult<T> =
  | { status: "fresh"; adapter: string; value: T; discarded: string[] }
  | { status: "all_stale"; discarded: string[] };

/** True when `lastUpdated` is no older than the window, and not in the future. */
export function isFresh(lastUpdated: string, now: number, windowMs = FRESHNESS_WINDOW_MS): boolean {
  const t = Date.parse(lastUpdated);
  if (Number.isNaN(t)) return false;
  const age = now - t;
  return age >= 0 && age <= windowMs;
}

/**
 * Fetches from each adapter in order and returns the first fresh response. Stale or failing
 * responses are recorded as discarded.
 */
export async function fetchFresh<T>(
  fetchers: Array<{ adapter: string; fetch: () => Promise<TimedResponse<T>> }>,
  now: number = Date.now(),
  windowMs = FRESHNESS_WINDOW_MS,
): Promise<FreshnessResult<T>> {
  const discarded: string[] = [];
  for (const { adapter, fetch } of fetchers) {
    let response: TimedResponse<T>;
    try {
      response = await fetch();
    } catch {
      discarded.push(`${adapter}: request failed`);
      continue;
    }
    if (isFresh(response.lastUpdated, now, windowMs)) {
      return { status: "fresh", adapter: response.adapter, value: response.value, discarded };
    }
    discarded.push(`${adapter}: stale (${response.lastUpdated})`);
  }
  return { status: "all_stale", discarded };
}
