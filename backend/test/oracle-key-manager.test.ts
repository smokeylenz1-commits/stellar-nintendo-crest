/**
 * Tests for src/api/oracle-key-manager.ts (#291).
 *
 * Uses an in-memory store so no database is needed.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  OracleKeyManager,
  OracleKeyRecord,
  OracleKeyAuditEntry,
  OracleKeyStore,
  type OracleScope,
} from "../src/api/oracle-key-manager";

// ── Set the HMAC secret for tests ────────────────────────────────────────────
process.env.ORACLE_KEY_HMAC_SECRET = "0".repeat(64); // 32 zero bytes in hex

// ── In-memory store ──────────────────────────────────────────────────────────

function memoryKeyStore(): OracleKeyStore & { auditLog: OracleKeyAuditEntry[] } {
  const keys = new Map<string, OracleKeyRecord>();
  const auditLog: OracleKeyAuditEntry[] = [];
  return {
    auditLog,
    async saveKey(record) {
      keys.set(record.keyId, { ...record });
    },
    async getKey(keyId) {
      return keys.get(keyId);
    },
    async updateKey(keyId, patch) {
      const existing = keys.get(keyId);
      if (existing) keys.set(keyId, { ...existing, ...patch });
    },
    async logInvocation(entry) {
      auditLog.push(entry);
    },
    async listActiveKeys() {
      return [...keys.values()];
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const dummyMeta = { ip: "1.2.3.4", userAgent: "TestBot/1.0" };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OracleKeyManager – issueKey", () => {
  it("returns a unique rawKey and keyId on each call", async () => {
    const mgr = new OracleKeyManager(memoryKeyStore());
    const a = await mgr.issueKey({ providerName: "P", scopes: ["oracle:submit"] });
    const b = await mgr.issueKey({ providerName: "P", scopes: ["oracle:submit"] });
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyId).not.toBe(b.keyId);
  });

  it("stores a hash, not the plaintext key", async () => {
    const store = memoryKeyStore();
    const mgr = new OracleKeyManager(store);
    const { rawKey, keyId } = await mgr.issueKey({ providerName: "P", scopes: ["oracle:read"] });
    const record = await store.getKey(keyId);
    expect(record).toBeDefined();
    expect(record!.keyHash).not.toBe(rawKey);
    expect(record!.keyHash.length).toBeGreaterThan(0);
  });

  it("sets expiresAt to now + ttlMs when ttlMs is provided", async () => {
    const mgr = new OracleKeyManager(memoryKeyStore());
    const before = Date.now();
    const { expiresAt } = await mgr.issueKey({
      providerName: "P",
      scopes: ["oracle:submit"],
      ttlMs: 60_000,
    });
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000 + 100);
  });
});

describe("OracleKeyManager – verifyKey", () => {
  let store: ReturnType<typeof memoryKeyStore>;
  let mgr: OracleKeyManager;

  beforeEach(() => {
    store = memoryKeyStore();
    mgr = new OracleKeyManager(store);
  });

  it("returns ok:true for a valid key with the correct scope", async () => {
    const { rawKey } = await mgr.issueKey({
      providerName: "Acme Oracle",
      scopes: ["oracle:submit"],
    });
    const result = await mgr.verifyKey({
      rawKey,
      requiredScope: "oracle:submit",
      ...dummyMeta,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerName).toBe("Acme Oracle");
  });

  it("returns 401 for an unknown key", async () => {
    const result = await mgr.verifyKey({
      rawKey: "completely-made-up-key",
      requiredScope: "oracle:submit",
      ...dummyMeta,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown key/);
  });

  it("returns 401 when the key lacks the required scope", async () => {
    const { rawKey } = await mgr.issueKey({
      providerName: "ReadOnly",
      scopes: ["oracle:read"],
    });
    const result = await mgr.verifyKey({
      rawKey,
      requiredScope: "oracle:submit",
      ...dummyMeta,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/oracle:submit/);
  });

  it("returns 401 for an expired key", async () => {
    const { rawKey } = await mgr.issueKey({
      providerName: "Expired",
      scopes: ["oracle:submit"],
      ttlMs: -1, // already expired
    });
    const result = await mgr.verifyKey({
      rawKey,
      requiredScope: "oracle:submit",
      ...dummyMeta,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/);
  });

  it("returns 401 for a revoked key", async () => {
    const { rawKey, keyId } = await mgr.issueKey({
      providerName: "Revoked",
      scopes: ["oracle:submit"],
    });
    await mgr.revokeKey(keyId);
    const result = await mgr.verifyKey({
      rawKey,
      requiredScope: "oracle:submit",
      ...dummyMeta,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/revoked/);
  });

  it("logs every invocation (success and failure) to the audit table", async () => {
    const { rawKey } = await mgr.issueKey({ providerName: "P", scopes: ["oracle:submit"] });

    // Success
    await mgr.verifyKey({ rawKey, requiredScope: "oracle:submit", ...dummyMeta });
    // Failure
    await mgr.verifyKey({ rawKey: "bad", requiredScope: "oracle:submit", ...dummyMeta });

    expect(store.auditLog).toHaveLength(2);
    expect(store.auditLog[0].success).toBe(true);
    expect(store.auditLog[1].success).toBe(false);
  });

  it("logs IP and user-agent on each invocation", async () => {
    const { rawKey } = await mgr.issueKey({ providerName: "P", scopes: ["oracle:read"] });
    await mgr.verifyKey({
      rawKey,
      requiredScope: "oracle:read",
      ip: "192.168.1.1",
      userAgent: "Mozilla/5.0",
    });
    const entry = store.auditLog[0];
    expect(entry.ip).toBe("192.168.1.1");
    expect(entry.userAgent).toBe("Mozilla/5.0");
  });

  it("updates lastUsedAt on successful verification", async () => {
    const { rawKey, keyId } = await mgr.issueKey({ providerName: "P", scopes: ["oracle:read"] });
    const before = new Date().toISOString();
    await mgr.verifyKey({ rawKey, requiredScope: "oracle:read", ...dummyMeta });
    const record = await store.getKey(keyId);
    expect(record!.lastUsedAt).not.toBeNull();
    expect(record!.lastUsedAt! >= before).toBe(true);
  });
});

describe("OracleKeyManager – revokeKey", () => {
  it("makes the key immediately unusable", async () => {
    const store = memoryKeyStore();
    const mgr = new OracleKeyManager(store);
    const { rawKey, keyId } = await mgr.issueKey({ providerName: "P", scopes: ["oracle:submit"] });

    await mgr.revokeKey(keyId);

    const result = await mgr.verifyKey({ rawKey, requiredScope: "oracle:submit", ...dummyMeta });
    expect(result.ok).toBe(false);
  });

  it("throws when revoking a non-existent key", async () => {
    const mgr = new OracleKeyManager(memoryKeyStore());
    await expect(mgr.revokeKey("nonexistent")).rejects.toThrow(/Key not found/);
  });
});

describe("OracleKeyManager – listActiveKeys", () => {
  it("excludes revoked and expired keys", async () => {
    const store = memoryKeyStore();
    const mgr = new OracleKeyManager(store);

    const { keyId: activeId } = await mgr.issueKey({ providerName: "Active", scopes: ["oracle:read"] });
    const { keyId: revokedId } = await mgr.issueKey({ providerName: "Revoked", scopes: ["oracle:read"] });
    await mgr.issueKey({ providerName: "Expired", scopes: ["oracle:read"], ttlMs: -1 });

    await mgr.revokeKey(revokedId);

    const active = await mgr.listActiveKeys();
    const ids = active.map((k) => k.keyId);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(revokedId);
  });
});
