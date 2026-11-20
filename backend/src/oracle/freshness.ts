/**
 * Oracle freshness helpers.
 *
 * All market expiration / resolution timestamps are evaluated strictly against
 * UTC Unix epoch seconds. Ambiguous local date strings (no explicit UTC offset)
 * are rejected so that daylight saving transitions and timezone offsets can
 * never cause premature or delayed market resolutions.
 */

const ISO_UTC_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const EPOCH_SECONDS = /^-?\d+$/;

/**
 * Resolve an ISO 8601 timestamp (with explicit UTC offset) or a numeric epoch
 * seconds value to UTC Unix epoch seconds.
 *
 * Throws on ambiguous local timezone strings (no explicit offset) and on
 * invalid / out-of-range dates.
 */
export function resolveUtcEpochSeconds(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new Error(`Invalid epoch seconds: ${input}`);
    }
    return input;
  }

  if (typeof input !== 'string') {
    throw new Error('Timestamp must be an ISO 8601 string or epoch seconds');
  }

  const value = input.trim();
  if (value.length === 0) {
    throw new Error('Timestamp must not be empty');
  }

  if (EPOCH_SECONDS.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) {
      throw new Error(`Epoch seconds out of range: ${value}`);
    }
    return seconds;
  }

  if (!ISO_UTC_WITH_OFFSET.test(value)) {
    throw new Error(
      `Ambiguous or unsupported timestamp "${value}": expected ISO 8601 with explicit UTC offset (Z or ±HH:MM) or epoch seconds`,
    );
  }

  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return Math.floor(millis / 1000);
}

/**
 * Resolve a timestamp to UTC Unix epoch milliseconds.
 */
export function resolveUtcEpochMillis(input: string | number): number {
  return resolveUtcEpochSeconds(input) * 1000;
}

/**
 * Compare two timestamps in UTC epoch seconds.
 * Returns a negative number if a < b, positive if a > b, 0 if equal.
 */
export function compareUtcTimestamps(
  a: string | number,
  b: string | number,
): number {
  return resolveUtcEpochSeconds(a) - resolveUtcEpochSeconds(b);
}

/**
 * Determine whether a market expiration timestamp has passed relative to now.
 */
export function isExpired(
  expiresAt: string | number,
  now: string | number = Math.floor(Date.now() / 1000),
): boolean {
  return resolveUtcEpochSeconds(expiresAt) <= resolveUtcEpochSeconds(now);
}
