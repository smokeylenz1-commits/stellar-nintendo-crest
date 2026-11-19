/**
 * Oracle API key handling without a development fallback (#39).
 *
 * The key must come from the environment. A missing key is a fatal boot error outside tests,
 * and nothing in the code supplies a default. Bearer tokens are compared as SHA-256 hashes in
 * constant time, so the raw key is never stored.
 *
 * Tiered rate limiting (#235): public requests are limited per client IP, authenticated
 * requests per wallet address. Internal service IPs and trusted indexer hooks bypass limits.
 */

import { createHash, timingSafeEqual } from "crypto";

export class OracleKeyError extends Error {}

/** Reads `ORACLE_API_KEY`. Throws outside the test environment when it is absent or empty. */
export function requireOracleApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.ORACLE_API_KEY;
  if (env.NODE_ENV === "test") {
    return key && key.length > 0 ? key : undefined;
  }
  if (!key || key.length === 0) {
    throw new OracleKeyError("ORACLE_API_KEY must be set; refusing to start without it");
  }
  return key;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Checks a `Bearer <token>` header against the expected SHA-256 hash of the key. */
export function verifyBearerToken(authorizationHeader: string | undefined, expectedHashHex: string): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(sha256Hex(authorizationHeader.slice("Bearer ".length)), "hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Requests per minute allowed for unauthenticated (IP-keyed) traffic. */
export const PUBLIC_RATE_LIMIT_PER_MINUTE = 60;
/** Requests per minute allowed for authenticated (wallet-keyed) traffic. */
export const AUTHENTICATED_RATE_LIMIT_PER_MINUTE = 300;

/**
 * Parses a comma-separated allowlist (e.g. `RATE_LIMIT_WHITELIST_IPS`).
 * Empty or missing values yield an empty list.
 */
export function parseIpWhitelist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolves the rate-limit bucket key and limit for a request.
 *
 * Authenticated requests are keyed by wallet address (300 req/min); everything else is keyed
 * by client IP (60 req/min). Returns `null` when the caller is whitelisted and should bypass
 * rate limiting entirely.
 */
export function resolveRateLimitBucket(params: {
  ip: string | undefined;
  walletAddress?: string | undefined;
  whitelistedIps?: string[];
  trustedIndexer?: boolean;
}): { key: string; limit: number } | null {
  const { ip, walletAddress, whitelistedIps = [], trustedIndexer = false } = params;
  if (trustedIndexer) return null;
  if (ip && whitelistedIps.includes(ip)) return null;
  if (walletAddress && walletAddress.length > 0) {
    return { key: `wallet:${walletAddress.toLowerCase()}`, limit: AUTHENTICATED_RATE_LIMIT_PER_MINUTE };
  }
  return { key: `ip:${ip ?? "unknown"}`, limit: PUBLIC_RATE_LIMIT_PER_MINUTE };
}

/**
 * Builds the standard rate-limit response headers. `Retry-After` is only emitted when the
 * caller has exhausted the bucket (remaining === 0), matching HTTP 429 semantics.
 */
export function buildRateLimitHeaders(params: {
  limit: number;
  remaining: number;
  resetSeconds: number;
}): Record<string, string> {
  const { limit, remaining, resetSeconds } = params;
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(limit),
    "RateLimit-Remaining": String(Math.max(0, remaining)),
  };
  if (remaining <= 0) {
    headers["Retry-After"] = String(Math.max(0, Math.ceil(resetSeconds)));
  }
  return headers;
}
