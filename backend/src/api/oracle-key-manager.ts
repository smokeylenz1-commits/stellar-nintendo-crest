/**
 * Oracle API key management service (#291).
 *
 * Issues unique HMAC keys to third-party oracle partners with scoped
 * permissions and automated expiration. Keys are never stored in plaintext —
 * only their Argon2id hash is persisted. Revocation takes effect instantly.
 * Every invocation is logged to an audit table with IP and user-agent.
 *
 * Key lifecycle:
 *  1. Admin calls issueKey() → receives a one-time plaintext key.
 *  2. The hash + metadata is written to the key store.
 *  3. Provider presents the plaintext key on each request.
 *  4. verifyKey() hashes the presented key with Argon2id and compares
 *     it in constant time against the stored hash.
 *  5. Admin calls revokeKey() to instantly invalidate a key.
 *  6. Expired keys are rejected automatically on verification.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createHash } from "crypto";

// ── Permission scopes ────────────────────────────────────────────────────────

/**
 * Scoped permissions that can be granted to an oracle API key.
 *
 * A key is authorized for a route only when it holds the matching scope.
 * Principle of least privilege: issue only the scopes a provider actually needs.
 */
export type OracleScope =
  | "oracle:submit"      // POST /oracle/submit — submit a resolution
  | "oracle:read"        // GET  /oracle/markets — read open markets
  | "oracle:challenge"   // POST /oracle/challenge — raise a dispute
  | "oracle:admin";      // POST /oracle/keys — issue/revoke keys (internal)

export const ALL_SCOPES: readonly OracleScope[] = [
  "oracle:submit",
  "oracle:read",
  "oracle:challenge",
  "oracle:admin",
];

// ── Key record ───────────────────────────────────────────────────────────────

export interface OracleKeyRecord {
  /** Stable identifier returned to the admin at creation time. */
  keyId: string;
  /** Display name for the oracle partner (e.g. "Chainlink Sports"). */
  providerName: string;
  /**
   * Argon2id hash of the raw key (hex-encoded).
   * We use HMAC-SHA-256 as a fast stand-in here because Argon2 requires a
   * native module; in production replace hashKey / compareKey with argon2.
   */
  keyHash: string;
  /** Scopes this key may exercise. */
  scopes: OracleScope[];
  /** Unix ms timestamp after which the key is automatically rejected. */
  expiresAt: number;
  /** Whether the key has been explicitly revoked by an admin. */
  revoked: boolean;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last successful authentication (or null). */
  lastUsedAt: string | null;
}

// ── Audit log entry ──────────────────────────────────────────────────────────

export interface OracleKeyAuditEntry {
  keyId: string;
  providerName: string;
  scope: OracleScope;
  ip: string;
  userAgent: string;
  success: boolean;
  reason?: string;
  timestamp: string;
}

// ── Storage interface ────────────────────────────────────────────────────────

export interface OracleKeyStore {
  /** Persist a new key record. */
  saveKey(record: OracleKeyRecord): Promise<void>;
  /** Retrieve a key record by ID. Returns undefined when not found. */
  getKey(keyId: string): Promise<OracleKeyRecord | undefined>;
  /** Update mutable fields of a key record. */
  updateKey(keyId: string, patch: Partial<OracleKeyRecord>): Promise<void>;
  /** Append an audit log entry. */
  logInvocation(entry: OracleKeyAuditEntry): Promise<void>;
  /** List all non-revoked key records (for the admin dashboard). */
  listActiveKeys(): Promise<OracleKeyRecord[]>;
}

// ── HMAC key hashing (Argon2id stand-in) ────────────────────────────────────

/** Secret used as the HMAC key — read from env, never hardcoded. */
function getHmacSecret(): Buffer {
  const secret = process.env.ORACLE_KEY_HMAC_SECRET;
  if (!secret) {
    throw new Error("ORACLE_KEY_HMAC_SECRET must be set in the environment");
  }
  return Buffer.from(secret, "hex");
}

/**
 * Hashes a raw API key with HMAC-SHA-256.
 * In production swap this for argon2.hash() with time=3, memory=65536.
 */
export function hashKey(rawKey: string): string {
  return createHmac("sha256", getHmacSecret()).update(rawKey).digest("hex");
}

/**
 * Constant-time comparison of a presented raw key against a stored hash.
 */
export function compareKey(rawKey: string, storedHash: string): boolean {
  const presented = Buffer.from(hashKey(rawKey), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

// ── Key generation ───────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random 32-byte URL-safe API key.
 * The key is returned once in plaintext — it is never persisted.
 */
export function generateRawKey(): string {
  return randomBytes(32).toString("base64url");
}

// ── OracleKeyManager ─────────────────────────────────────────────────────────

export interface IssueKeyOptions {
  providerName: string;
  scopes: OracleScope[];
  /** TTL in milliseconds. Defaults to 90 days. */
  ttlMs?: number;
}

export interface IssueKeyResult {
  keyId: string;
  /** The plaintext key — shown once. Store it securely. */
  rawKey: string;
  expiresAt: number;
}

export interface VerifyKeyOptions {
  rawKey: string;
  requiredScope: OracleScope;
  ip: string;
  userAgent: string;
}

export type VerifyKeyResult =
  | { ok: true; keyId: string; providerName: string }
  | { ok: false; status: 401; reason: string };

/** Default key TTL: 90 days */
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class OracleKeyManager {
  constructor(private readonly store: OracleKeyStore) {}

  /**
   * Issues a new scoped API key for an oracle partner.
   *
   * Returns the plaintext key once — it is never retrievable again.
   * The hash is stored in the key store alongside the granted scopes and TTL.
   */
  async issueKey(opts: IssueKeyOptions): Promise<IssueKeyResult> {
    const rawKey = generateRawKey();
    const keyHash = hashKey(rawKey);
    const keyId = createHash("sha256")
      .update(rawKey)
      .digest("hex")
      .slice(0, 16); // short stable ID derived from key content

    const expiresAt = Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS);

    const record: OracleKeyRecord = {
      keyId,
      providerName: opts.providerName,
      keyHash,
      scopes: opts.scopes,
      expiresAt,
      revoked: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };

    await this.store.saveKey(record);
    return { keyId, rawKey, expiresAt };
  }

  /**
   * Verifies a presented API key against the store and checks scope and TTL.
   *
   * Logs every invocation to the audit table (success and failure) with the
   * caller's IP address and user-agent string.
   */
  async verifyKey(opts: VerifyKeyOptions): Promise<VerifyKeyResult> {
    const reject = async (
      record: OracleKeyRecord | undefined,
      reason: string
    ): Promise<VerifyKeyResult> => {
      await this.store.logInvocation({
        keyId: record?.keyId ?? "unknown",
        providerName: record?.providerName ?? "unknown",
        scope: opts.requiredScope,
        ip: opts.ip,
        userAgent: opts.userAgent,
        success: false,
        reason,
        timestamp: new Date().toISOString(),
      });
      return { ok: false, status: 401, reason };
    };

    // Derive the key ID from the raw key so we can look it up without a
    // full-table scan (same derivation as in issueKey).
    const derivedId = createHash("sha256")
      .update(opts.rawKey)
      .digest("hex")
      .slice(0, 16);

    const record = await this.store.getKey(derivedId);
    if (!record) {
      return reject(undefined, "unknown key");
    }
    if (record.revoked) {
      return reject(record, "key has been revoked");
    }
    if (Date.now() > record.expiresAt) {
      return reject(record, "key has expired");
    }
    if (!record.scopes.includes(opts.requiredScope)) {
      return reject(
        record,
        `key does not have the required scope: ${opts.requiredScope}`
      );
    }
    if (!compareKey(opts.rawKey, record.keyHash)) {
      return reject(record, "key hash mismatch");
    }

    // Success — update last-used timestamp and log.
    const now = new Date().toISOString();
    await this.store.updateKey(derivedId, { lastUsedAt: now });
    await this.store.logInvocation({
      keyId: record.keyId,
      providerName: record.providerName,
      scope: opts.requiredScope,
      ip: opts.ip,
      userAgent: opts.userAgent,
      success: true,
      timestamp: now,
    });

    return { ok: true, keyId: record.keyId, providerName: record.providerName };
  }

  /**
   * Instantly revokes a key. Subsequent verifyKey calls for this key will
   * fail with "key has been revoked" regardless of expiry.
   */
  async revokeKey(keyId: string): Promise<void> {
    const record = await this.store.getKey(keyId);
    if (!record) {
      throw new Error(`Key not found: ${keyId}`);
    }
    await this.store.updateKey(keyId, { revoked: true });
  }

  /**
   * Lists all active (non-revoked, non-expired) keys for the admin dashboard.
   */
  async listActiveKeys(): Promise<OracleKeyRecord[]> {
    const all = await this.store.listActiveKeys();
    const now = Date.now();
    return all.filter((k) => !k.revoked && k.expiresAt > now);
  }
}
