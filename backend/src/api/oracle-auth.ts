/**
 * Oracle API key handling without a development fallback (#39).
 *
 * The key must come from the environment. A missing key is a fatal boot error outside tests,
 * and nothing in the code supplies a default. Bearer tokens are compared as SHA-256 hashes in
 * constant time, so the raw key is never stored.
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
