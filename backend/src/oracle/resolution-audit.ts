/**
 * Immutable audit records for automated resolutions (#43).
 *
 * Every automated submission stores the raw source response (status, headers, body) and a SHA-256
 * hash over that evidence, so a dispute can be checked against exactly what the oracle saw. The
 * hash is computed over a canonical JSON form with sorted keys, so the same evidence always hashes
 * the same. Records are insert-only: the store exposes no update.
 *
 * The same module also defines the administrative audit trail (#251): a generic `audit_logs`
 * record capturing actor, action, target entity, IP address and a JSON diff of changes, plus a
 * read-only querying API for security auditors.
 */

import { createHash } from "crypto";

export interface SourceEvidence {
  source: string;
  httpStatus: number;
  headers: Record<string, string>;
  rawBody: string;
  fetchedAt: string;
}

export interface AuditRecord {
  marketId: number;
  submittedOutcome: "YES" | "NO";
  resolvedAt: string;
  evidence: SourceEvidence[];
  evidenceSha256: string;
}

/** JSON with object keys sorted at every level, so equal values serialise equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashEvidence(evidence: SourceEvidence[]): string {
  return createHash("sha256").update(canonicalJson(evidence)).digest("hex");
}

export function buildAuditRecord(
  marketId: number,
  submittedOutcome: "YES" | "NO",
  evidence: SourceEvidence[],
  resolvedAt: Date = new Date(),
): AuditRecord {
  return {
    marketId,
    submittedOutcome,
    resolvedAt: resolvedAt.toISOString(),
    evidence,
    evidenceSha256: hashEvidence(evidence),
  };
}

/** Recomputes the hash from the stored evidence. A mismatch means the record was altered. */
export function verifyAuditRecord(record: AuditRecord): boolean {
  return hashEvidence(record.evidence) === record.evidenceSha256;
}

/** Insert-only store. There is deliberately no update or delete. */
export interface AuditStore {
  insert(record: AuditRecord): Promise<void>;
  findByMarket(marketId: number): Promise<AuditRecord[]>;
}

/**
 * Administrative audit trail (#251).
 *
 * Rows are append-only: the database grants the application user INSERT/SELECT only
 * (`REVOKE UPDATE, DELETE`), so an entry can never be rewritten after the fact.
 */
export type AuditAction =
  | "admin_override"
  | "council_dispute_verdict"
  | "market_pause"
  | "market_resume"
  | "config_change";

export type AuditEntityType = "market" | "dispute" | "config" | "user";

/** A single field-level change, stored inside the `metadata` JSONB diff. */
export interface AuditDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AuditLogEntry {
  /** Wallet address of the actor who performed the action. */
  actor: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  /** Originating IP address, when known. */
  ipAddress: string | null;
  /** JSON diff of the changes applied by this action. */
  metadata: { changes: AuditDiffEntry[]; [key: string]: unknown };
  createdAt: string;
}

/** Builds a diff between two flat snapshots, for storage in `metadata.changes`. */
export function buildAuditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditDiffEntry[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: AuditDiffEntry[] = [];
  for (const field of fields) {
    const prev = before[field];
    const next = after[field];
    if (canonicalJson(prev) !== canonicalJson(next)) {
      changes.push({ field, before: prev, after: next });
    }
  }
  return changes;
}

/** Filters accepted by the auditor querying API. All fields are optional. */
export interface AuditLogQuery {
  actor?: string;
  action?: AuditAction;
  entityType?: AuditEntityType;
  entityId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Read-only querying API for security auditors. */
export interface AuditLogReader {
  query(filter: AuditLogQuery): Promise<AuditLogEntry[]>;
}

/** Append-only writer. There is deliberately no update or delete. */
export interface AuditLogWriter {
  append(entry: Omit<AuditLogEntry, "createdAt">): Promise<void>;
}
