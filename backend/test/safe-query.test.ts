/**
 * Tests for src/db/safe-query.ts (#287).
 *
 * Validates:
 *  - sql tagged template produces correct text/values
 *  - safeOrderBy allowlist enforcement
 *  - buildInsertQuery / buildUpdateQuery parameterization
 *  - BetFilterSchema Zod validation
 *  - buildBetListQuery produces fully parameterized output with no interpolation
 *  - SQL injection fuzzing: common injection payloads are rejected
 */

import { describe, expect, it } from "vitest";
import {
  sql,
  safeOrderBy,
  buildInsertQuery,
  buildUpdateQuery,
  buildBetListQuery,
  BetFilterSchema,
  ALLOWED_SORT_COLUMNS,
} from "../src/db/safe-query";

// ── sql tagged template ──────────────────────────────────────────────────────

describe("sql tagged template", () => {
  it("produces correct text with numbered placeholders", () => {
    const q = sql`SELECT * FROM bets WHERE market_id = ${7} AND bettor = ${"GABC"}`;
    expect(q.text).toBe("SELECT * FROM bets WHERE market_id = $1 AND bettor = $2");
    expect(q.values).toEqual([7, "GABC"]);
  });

  it("handles a single interpolation", () => {
    const q = sql`SELECT * FROM markets WHERE id = ${42}`;
    expect(q.text).toBe("SELECT * FROM markets WHERE id = $1");
    expect(q.values).toEqual([42]);
  });

  it("handles no interpolations", () => {
    const q = sql`SELECT COUNT(*) FROM bets`;
    expect(q.text).toBe("SELECT COUNT(*) FROM bets");
    expect(q.values).toEqual([]);
  });

  it("never puts a raw value into the query text", () => {
    const injection = "1; DROP TABLE bets; --";
    const q = sql`SELECT * FROM bets WHERE bettor = ${injection}`;
    expect(q.text).not.toContain(injection);
    expect(q.text).toBe("SELECT * FROM bets WHERE bettor = $1");
    expect(q.values[0]).toBe(injection);
  });
});

// ── safeOrderBy ─────────────────────────────────────────────────────────────

describe("safeOrderBy", () => {
  it("returns a valid ORDER BY fragment for every allowed column", () => {
    for (const col of ALLOWED_SORT_COLUMNS) {
      const fragment = safeOrderBy(col, "ASC");
      expect(fragment).toBe(`ORDER BY "${col}" ASC`);
    }
  });

  it("defaults direction to ASC", () => {
    expect(safeOrderBy("created_at")).toBe('ORDER BY "created_at" ASC');
  });

  it("supports DESC direction", () => {
    expect(safeOrderBy("gross_amount", "DESC")).toBe('ORDER BY "gross_amount" DESC');
  });

  it("throws for a column not in the allowlist", () => {
    expect(() => safeOrderBy("password")).toThrow(/not an allowed sort column/);
  });

  // SQL injection payloads
  const injectionPayloads = [
    "created_at; DROP TABLE bets; --",
    "1 UNION SELECT * FROM users",
    "created_at` OR 1=1 --",
    "(SELECT pg_sleep(5))",
    "created_at\0malicious",
  ];

  for (const payload of injectionPayloads) {
    it(`rejects injection payload: ${JSON.stringify(payload)}`, () => {
      expect(() => safeOrderBy(payload)).toThrow(/not an allowed sort column/);
    });
  }
});

// ── buildInsertQuery ─────────────────────────────────────────────────────────

describe("buildInsertQuery", () => {
  it("produces correct INSERT with numbered placeholders", () => {
    const q = buildInsertQuery("bets", {
      market_id: 7,
      bettor: "GABC",
      is_yes: true,
    });
    expect(q.text).toBe(`INSERT INTO "bets" ("market_id","bettor","is_yes") VALUES ($1, $2, $3)`);
    expect(q.values).toEqual([7, "GABC", true]);
  });

  it("never interpolates a value into the query text", () => {
    const q = buildInsertQuery("bets", {
      bettor: "1'; DROP TABLE bets; --",
    });
    expect(q.text).not.toContain("DROP TABLE");
    expect(q.values[0]).toBe("1'; DROP TABLE bets; --");
  });

  it("throws for a table name with disallowed characters", () => {
    expect(() => buildInsertQuery("bets; DROP TABLE users", { x: 1 })).toThrow(
      /disallowed characters/
    );
  });

  it("throws for a column name with disallowed characters", () => {
    expect(() => buildInsertQuery("bets", { "col; --": 1 })).toThrow(/disallowed characters/);
  });
});

// ── buildUpdateQuery ─────────────────────────────────────────────────────────

describe("buildUpdateQuery", () => {
  it("produces correct UPDATE with numbered placeholders", () => {
    const q = buildUpdateQuery("markets", { total_yes: 1000n }, "id", 7);
    expect(q.text).toBe(`UPDATE "markets" SET "total_yes" = $1 WHERE "id" = $2`);
    expect(q.values).toEqual([1000n, 7]);
  });

  it("never interpolates the key value into the query text", () => {
    const q = buildUpdateQuery("markets", { name: "test" }, "id", "7; DROP TABLE markets; --");
    expect(q.text).not.toContain("DROP TABLE");
    expect(q.values[1]).toBe("7; DROP TABLE markets; --");
  });
});

// ── BetFilterSchema ──────────────────────────────────────────────────────────

describe("BetFilterSchema", () => {
  it("accepts a valid filter with all fields", () => {
    const result = BetFilterSchema.safeParse({
      marketId: 1,
      bettor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      isYes: true,
      sortBy: "created_at",
      sortDir: "DESC",
      limit: 20,
      offset: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty filter and applies defaults", () => {
    const result = BetFilterSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it("rejects a non-allowlisted sortBy", () => {
    const result = BetFilterSchema.safeParse({ sortBy: "password" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid Stellar bettor address", () => {
    const result = BetFilterSchema.safeParse({ bettor: "not-an-address" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative marketId", () => {
    const result = BetFilterSchema.safeParse({ marketId: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects limit > 1000", () => {
    const result = BetFilterSchema.safeParse({ limit: 1001 });
    expect(result.success).toBe(false);
  });
});

// ── buildBetListQuery ────────────────────────────────────────────────────────

describe("buildBetListQuery", () => {
  it("produces a fully parameterized query for a full filter", () => {
    const filter = BetFilterSchema.parse({
      marketId: 7,
      bettor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      isYes: false,
      sortBy: "created_at",
      sortDir: "DESC",
      limit: 10,
      offset: 5,
    });
    const q = buildBetListQuery(filter);

    // No raw values in the text
    expect(q.text).not.toContain("7");
    expect(q.text).not.toContain("GAAA");
    expect(q.text).toContain("$1");
    expect(q.text).toContain("$2");
    expect(q.text).toContain('ORDER BY "created_at" DESC');
    expect(q.values).toContain(7);
    expect(q.values).toContain(false);
  });

  it("omits WHERE clause when no filter fields are set", () => {
    const filter = BetFilterSchema.parse({});
    const q = buildBetListQuery(filter);
    expect(q.text).not.toContain("WHERE");
    expect(q.text).toContain("LIMIT");
  });

  it("never puts a sortBy injection attempt into the query text", () => {
    // BetFilterSchema rejects non-allowlisted sortBy, so the query builder
    // never receives it — verify defense-in-depth at the safeOrderBy level.
    expect(() => safeOrderBy("1 UNION SELECT password FROM users", "ASC")).toThrow(
      /not an allowed sort column/
    );
  });
});
