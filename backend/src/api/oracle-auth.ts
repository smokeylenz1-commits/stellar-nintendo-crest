/**
 * Oracle API key handling without a development fallback (#39).
 *
 * The key must come from the environment. A missing key is a fatal boot error outside tests,
 * and nothing in the code supplies a default. Bearer tokens are compared as SHA-256 hashes in
 * constant time, so the raw key is never stored.
 *
 * Webhook requests are additionally authenticated with an HMAC-SHA256 signature (#224):
 * `X-Oracle-Signature: sha256=<hex>` over `<timestamp>.<body>`, with a bounded timestamp
 * tolerance window to block replay attacks.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

export class OracleKeyError extends Error {}

/** Default tolerance (seconds) for the signed timestamp before a request is rejected. */
export const ORACLE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type OracleSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing-signature" | "malformed-signature" | "missing-timestamp" | "stale-timestamp" | "invalid-signature" };

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

/** Computes the canonical `sha256=<hex>` signature for a timestamp and raw request body. */
export function computeOracleSignature(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${digest}`;
}

/**
 * Verifies the `X-Oracle-Signature` header against the raw body and timestamp.
 *
 * The timestamp must be within `toleranceSeconds` of `nowSeconds` (default 300s) to block
 * replay attacks. Signature comparison is constant time.
 */
export function verifyOracleSignature(params: {
  secret: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  body: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): OracleSignatureResult {
  const { secret, signatureHeader, timestampHeader, body } = params;
  const nowSeconds = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = params.toleranceSeconds ?? ORACLE_SIGNATURE_TOLERANCE_SECONDS;

  if (!signatureHeader) return { ok: false, reason: "missing-signature" };
  if (!signatureHeader.startsWith("sha256=")) return { ok: false, reason: "malformed-signature" };

  if (!timestampHeader) return { ok: false, reason: "missing-timestamp" };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "missing-timestamp" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "stale-timestamp" };
  }

  const expected = Buffer.from(computeOracleSignature(secret, timestampHeader, body).slice("sha256=".length), "hex");
  const presented = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "invalid-signature" };
  }
  return { ok: true };
}
