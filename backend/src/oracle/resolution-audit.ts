/**
 * Immutable audit records for automated resolutions (#43).
 *
 * Every automated submission stores the raw source response (status, headers, body) and a SHA-256
 * hash over that evidence, so a dispute can be checked against exactly what the oracle saw. The
 * hash is computed over a canonical JSON form with sorted keys, so the same evidence always hashes
 * the same. Records are insert-only: the store exposes no update.
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
