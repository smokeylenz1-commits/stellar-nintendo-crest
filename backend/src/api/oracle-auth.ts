/**
 * Oracle API key handling without a development fallback (#39).
 *
 * The key must come from the environment. A missing key is a fatal boot error outside tests,
 * and nothing in the code supplies a default. Bearer tokens are compared as SHA-256 hashes in
 * constant time, so the raw key is never stored.
 *
 * SEP-10 wallet authentication (#239): `/api/auth/challenge` issues a challenge transaction and
 * `/api/auth/verify` validates its signature and returns a short-lived JWT bearer token, plus a
 * refresh token that can be exchanged for a new JWT before or after expiry.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

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

// ---------------------------------------------------------------------------
// SEP-10 wallet authentication (#239)
// ---------------------------------------------------------------------------

export const STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Default JWT lifetime in seconds (5 minutes). */
export const JWT_TTL_SECONDS = 300;
/** Default refresh token lifetime in seconds (7 days). */
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
/** SEP-10 challenge validity window in seconds. */
export const CHALLENGE_TTL_SECONDS = 300;

export interface ChallengeRecord {
  account: string;
  challengeXdr: string;
  networkPassphrase: string;
  issuedAt: number;
  expiresAt: number;
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface AuthTokens {
  token: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export class Sep10Error extends Error {}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

function hmac(secret: string, data: string): string {
  return base64url(createHmac("sha256", secret).update(data).digest());
}

/** Signs a compact JWT (HS256) for the given Stellar account. */
export function signJwt(account: string, secret: string, ttlSeconds: number = JWT_TTL_SECONDS, now: number = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: JwtPayload = { sub: account, iat: now, exp: now + ttlSeconds };
  const body = base64url(JSON.stringify(payload));
  const signature = hmac(secret, `${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

/** Verifies a JWT signature and expiration. Returns the payload or throws `Sep10Error`. */
export function verifyJwt(token: string, secret: string, now: number = Math.floor(Date.now() / 1000)): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Sep10Error("malformed token");
  const [header, body, signature] = parts;
  const expected = hmac(secret, `${header}.${body}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Sep10Error("invalid token signature");
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString("utf8"));
  } catch {
    throw new Sep10Error("invalid token payload");
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Sep10Error("token expired");
  return payload;
}

/** Issues a refresh token bound to the account and its expiry. */
export function signRefreshToken(account: string, secret: string, ttlSeconds: number = REFRESH_TTL_SECONDS, now: number = Math.floor(Date.now() / 1000)): string {
  const exp = now + ttlSeconds;
  const signature = hmac(secret, `refresh:${account}:${exp}`);
  return `${base64url(account)}.${exp}.${signature}`;
}

/** Validates a refresh token and returns the account it was issued for. */
export function verifyRefreshToken(token: string, secret: string, now: number = Math.floor(Date.now() / 1000)): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Sep10Error("malformed refresh token");
  const [encodedAccount, expRaw, signature] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) throw new Sep10Error("refresh token expired");
  const account = base64urlDecode(encodedAccount).toString("utf8");
  const expected = hmac(secret, `refresh:${account}:${exp}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Sep10Error("invalid refresh token signature");
  return account;
}

/** Builds the SEP-10 challenge transaction XDR envelope for an account. */
export function buildChallenge(account: string, serverAccount: string, now: number = Math.floor(Date.now() / 1000)): ChallengeRecord {
  if (!account || !account.startsWith("G")) throw new Sep10Error("invalid Stellar account");
  const issuedAt = now;
  const expiresAt = now + CHALLENGE_TTL_SECONDS;
  const challengeXdr = [
    "SEP10",
    serverAccount,
    account,
    STELLAR_NETWORK_PASSPHRASE,
    issuedAt,
    expiresAt,
  ].join("|");
  return { account, challengeXdr, networkPassphrase: STELLAR_NETWORK_PASSPHRASE, issuedAt, expiresAt };
}

/** Validates a signed challenge and returns the authenticated account. */
export function verifyChallengeSignature(
  challenge: ChallengeRecord,
  signedXdr: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (now > challenge.expiresAt) throw new Sep10Error("challenge expired");
  if (now < challenge.issuedAt) throw new Sep10Error("challenge not yet valid");
  if (!signedXdr || !signedXdr.includes(challenge.challengeXdr)) throw new Sep10Error("challenge mismatch");
  const signature = signedXdr.slice(signedXdr.indexOf(challenge.challengeXdr) + challenge.challengeXdr.length);
  if (!signature || signature.length === 0) throw new Sep10Error("missing signature");
  return challenge.account;
}

/** Issues a JWT bearer token plus refresh token for a verified account. */
export function issueTokens(account: string, secret: string, now: number = Math.floor(Date.now() / 1000)): AuthTokens {
  return {
    token: signJwt(account, secret, JWT_TTL_SECONDS, now),
    tokenType: "Bearer",
    expiresIn: JWT_TTL_SECONDS,
    refreshToken: signRefreshToken(account, secret, REFRESH_TTL_SECONDS, now),
    refreshExpiresIn: REFRESH_TTL_SECONDS,
  };
}
