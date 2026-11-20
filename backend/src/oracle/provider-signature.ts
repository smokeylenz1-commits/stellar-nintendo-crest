/**
 * Signature verification for external oracle providers (#40).
 *
 * A provider signs a challenge that binds the market, the outcome and a timestamp, so a captured
 * signature cannot be replayed for another market or after the freshness window. The signature
 * is checked against the provider's registered Stellar ed25519 public key. The primitive is
 * injected: the Stellar SDK's `Keypair.verify` is the intended implementation. An invalid or
 * stale payload is rejected with HTTP 401.
 *
 * Off-chain oracle webhook endpoints (#224) additionally authenticate the raw request body with
 * a SHA-256 HMAC carried in the `X-Oracle-Signature: sha256=<hex>` header. The HMAC is computed
 * over `<timestamp>.<body>` so the timestamp is bound to the payload and cannot be swapped to
 * extend the replay window.
 */

export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** Replay-protection window for HMAC-signed webhook requests (#224). */
export const MAX_HMAC_AGE_SECONDS = 300;

export const ORACLE_SIGNATURE_HEADER = "x-oracle-signature";
export const ORACLE_TIMESTAMP_HEADER = "x-oracle-timestamp";

export interface ProviderSubmission {
  marketId: number;
  outcome: "YES" | "NO";
  signature: string;
  provider: string;
  signedAt: number;
}

export interface ProviderKeyStore {
  publicKeyFor(provider: string): string | undefined;
}

export type Ed25519Verify = (publicKey: string, message: string, signatureBase64: string) => boolean;

/** The exact bytes a provider signs. */
export function challengeFor(submission: Pick<ProviderSubmission, "marketId" | "outcome" | "signedAt">): string {
  return `iPredict|oracle|${submission.marketId}|${submission.outcome}|${submission.signedAt}`;
}

export type VerifyResult = { ok: true } | { ok: false; status: 401; reason: string };

export function verifyProviderSubmission(
  submission: ProviderSubmission,
  keys: ProviderKeyStore,
  verify: Ed25519Verify,
  now: number = Date.now(),
): VerifyResult {
  const reject = (reason: string): VerifyResult => ({ ok: false, status: 401, reason });

  if (!submission.signature) {
    return reject("unsigned submission");
  }
  const publicKey = keys.publicKeyFor(submission.provider);
  if (!publicKey) {
    return reject("unknown provider");
  }
  if (Math.abs(now - submission.signedAt) > MAX_SIGNATURE_AGE_MS) {
    return reject("signature is stale or from the future");
  }
  if (!verify(publicKey, challengeFor(submission), submission.signature)) {
    return reject("signature does not match the provider key");
  }
  return { ok: true };
}

/**
 * The exact bytes covered by the webhook HMAC: the timestamp is prefixed to the raw body so a
 * captured signature cannot be replayed with a fresh timestamp.
 */
export function hmacPayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/**
 * Parse an `X-Oracle-Signature` header of the form `sha256=<hex>`. Returns the lowercase hex
 * digest, or `undefined` when the header is missing or malformed.
 */
export function parseOracleSignatureHeader(header: string | undefined | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  return match ? match[1].toLowerCase() : undefined;
}

/** Constant-time comparison of two equal-length hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface HmacWebhookRequest {
  /** Raw request body exactly as received (before JSON parsing). */
  body: string;
  /** Value of the `X-Oracle-Signature` header. */
  signatureHeader: string | undefined | null;
  /** Value of the `X-Oracle-Timestamp` header, in seconds since the epoch. */
  timestampHeader: string | undefined | null;
}

export type HmacVerifyResult = { ok: true } | { ok: false; status: 401; reason: string };

/**
 * Verify the HMAC-SHA256 signature of an off-chain oracle webhook request (#224).
 *
 * Rejects with HTTP 401 when the signature header is missing/malformed, the timestamp is
 * missing/invalid, the timestamp falls outside the 300-second tolerance window, or the digest
 * does not match the expected HMAC of `<timestamp>.<body>`.
 */
export function verifyOracleWebhookHmac(
  request: HmacWebhookRequest,
  secret: string,
  computeHmacHex: (secret: string, payload: string) => string,
  now: number = Date.now(),
): HmacVerifyResult {
  const reject = (reason: string): HmacVerifyResult => ({ ok: false, status: 401, reason });

  const provided = parseOracleSignatureHeader(request.signatureHeader);
  if (!provided) {
    return reject("missing or malformed X-Oracle-Signature header");
  }

  const rawTimestamp = request.timestampHeader?.trim();
  if (!rawTimestamp || !/^\d+$/.test(rawTimestamp)) {
    return reject("missing or malformed X-Oracle-Timestamp header");
  }
  const timestampSeconds = Number(rawTimestamp);
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_HMAC_AGE_SECONDS) {
    return reject("timestamp outside the replay tolerance window");
  }

  const expected = computeHmacHex(secret, hmacPayload(rawTimestamp, request.body)).toLowerCase();
  if (!timingSafeEqualHex(expected, provided)) {
    return reject("signature does not match the request body");
  }
  return { ok: true };
}
