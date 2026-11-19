/**
 * SQL injection prevention utilities (#287).
 *
 * All database interactions in this service must go through these helpers.
 * Direct string interpolation into SQL is prohibited — the ESLint rule
 * `no-restricted-syntax` enforces this at CI time (see eslint.config.mjs).
 *
 * Design principles:
 *  - Parameterized queries only: values are passed as `$1, $2, …` placeholders,
 *    never interpolated into the query string.
 *  - Sort-column allowlisting: dynamic ORDER BY clauses use a strict allowlist
 *    so an attacker cannot inject arbitrary SQL through a sort parameter.
 *  - Input validation via Zod: every public entry-point that accepts external
 *    data validates it with a Zod schema before constructing a query.
 *
 * Usage:
 *   import { buildParameterizedQuery, safeOrderBy, validateBetFilter } from '@/db/safe-query';
 */

import { z } from "zod";

// ── Allowlisted sort columns ────────────────────────────────────────────────

/**
 * Columns that callers are permitted to sort by.
 * Any value not in this set is rejected before it reaches the query builder.
 */
export const ALLOWED_SORT_COLUMNS = new Set([
  "created_at",
  "gross_amount",
  "net_amount",
  "market_id",
  "points",
  "timestamp",
  "bettor",
  "is_yes",
]);

export type SortColumn = string;
export type SortDirection = "ASC" | "DESC";

/**
 * Returns a safe `ORDER BY` fragment.
 *
 * Throws if `column` is not in the allowlist so the caller never reaches
 * the database with an unsanitized identifier.
 *
 * @example
 *   const order = safeOrderBy("created_at", "DESC");
 *   // → 'ORDER BY "created_at" DESC'
 */
export function safeOrderBy(column: SortColumn, direction: SortDirection = "ASC"): string {
  if (!ALLOWED_SORT_COLUMNS.has(column)) {
    throw new Error(
      `SQL injection guard: "${column}" is not an allowed sort column. ` +
        `Allowed: ${[...ALLOWED_SORT_COLUMNS].join(", ")}`
    );
  }
  const safeDir = direction === "DESC" ? "DESC" : "ASC";
  // Double-quote the column identifier to prevent keyword clashes.
  return `ORDER BY "${column}" ${safeDir}`;
}

// ── Parameterized query builder ─────────────────────────────────────────────

export interface ParameterizedQuery {
  text: string;
  values: unknown[];
}

/**
 * Tagged-template helper that builds a `{ text, values }` object compatible
 * with `node-postgres` (`pg`) and `postgres.js`.
 *
 * Every interpolated value becomes a numbered placeholder (`$1`, `$2`, …)
 * in the query string; the raw values are collected in the `values` array.
 * This makes it impossible to accidentally interpolate a value directly into
 * the SQL text.
 *
 * @example
 *   const q = sql`SELECT * FROM bets WHERE market_id = ${marketId} AND bettor = ${address}`;
 *   // q.text   → 'SELECT * FROM bets WHERE market_id = $1 AND bettor = $2'
 *   // q.values → [marketId, address]
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): ParameterizedQuery {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      text += `$${i + 1}`;
    }
  }
  return { text, values };
}

/**
 * Builds a named parameterized query from a plain object of column→value pairs.
 *
 * @example
 *   const q = buildInsertQuery("bets", { market_id: 7, bettor: "GABC…", is_yes: true });
 *   // q.text   → 'INSERT INTO "bets" ("market_id","bettor","is_yes") VALUES ($1,$2,$3)'
 *   // q.values → [7, "GABC…", true]
 */
export function buildInsertQuery(
  table: string,
  row: Record<string, unknown>
): ParameterizedQuery {
  assertSafeIdentifier(table);
  const columns = Object.keys(row);
  columns.forEach(assertSafeIdentifier);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const colList = columns.map((c) => `"${c}"`).join(", ");
  return {
    text: `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
    values: Object.values(row),
  };
}

/**
 * Builds a parameterized `UPDATE … SET … WHERE id = $N` query.
 *
 * @example
 *   const q = buildUpdateQuery("markets", { total_yes: 1000n }, "id", 7);
 *   // q.text   → 'UPDATE "markets" SET "total_yes" = $1 WHERE "id" = $2'
 *   // q.values → [1000n, 7]
 */
export function buildUpdateQuery(
  table: string,
  updates: Record<string, unknown>,
  keyColumn: string,
  keyValue: unknown
): ParameterizedQuery {
  assertSafeIdentifier(table);
  assertSafeIdentifier(keyColumn);
  const columns = Object.keys(updates);
  columns.forEach(assertSafeIdentifier);
  const setClauses = columns.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
  const keyIndex = columns.length + 1;
  return {
    text: `UPDATE "${table}" SET ${setClauses} WHERE "${keyColumn}" = $${keyIndex}`,
    values: [...Object.values(updates), keyValue],
  };
}

// ── Zod input schemas ────────────────────────────────────────────────────────

/**
 * Validates and sanitizes a bet-list filter from an API request.
 * All fields are optional; missing fields are omitted from the WHERE clause.
 */
export const BetFilterSchema = z.object({
  marketId: z.number().int().positive().optional(),
  bettor: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, "bettor must be a valid Stellar G-address")
    .optional(),
  isYes: z.boolean().optional(),
  fromTimestamp: z.coerce.date().optional(),
  toTimestamp: z.coerce.date().optional(),
  sortBy: z
    .string()
    .refine((v) => ALLOWED_SORT_COLUMNS.has(v), {
      message: `sortBy must be one of: ${[...ALLOWED_SORT_COLUMNS].join(", ")}`,
    })
    .optional(),
  sortDir: z.enum(["ASC", "DESC"]).optional(),
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
});

export type BetFilter = z.infer<typeof BetFilterSchema>;

/**
 * Validates an oracle resolution submission from an external provider.
 */
export const OracleResolutionSchema = z.object({
  marketId: z.number().int().positive(),
  outcome: z.enum(["YES", "NO"]),
  signature: z.string().min(1),
  provider: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, "provider must be a valid Stellar G-address"),
  signedAt: z.number().int().positive(),
});

export type OracleResolution = z.infer<typeof OracleResolutionSchema>;

/**
 * Builds a parameterized SELECT query from a validated BetFilter.
 * Every dynamic value becomes a numbered placeholder; sort columns are
 * allowlisted so ORDER BY cannot be injected through the filter.
 */
export function buildBetListQuery(filter: BetFilter): ParameterizedQuery {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filter.marketId !== undefined) {
    conditions.push(`"market_id" = $${idx++}`);
    values.push(filter.marketId);
  }
  if (filter.bettor !== undefined) {
    conditions.push(`"bettor" = $${idx++}`);
    values.push(filter.bettor);
  }
  if (filter.isYes !== undefined) {
    conditions.push(`"is_yes" = $${idx++}`);
    values.push(filter.isYes);
  }
  if (filter.fromTimestamp !== undefined) {
    conditions.push(`"timestamp" >= $${idx++}`);
    values.push(filter.fromTimestamp);
  }
  if (filter.toTimestamp !== undefined) {
    conditions.push(`"timestamp" <= $${idx++}`);
    values.push(filter.toTimestamp);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy =
    filter.sortBy !== undefined
      ? safeOrderBy(filter.sortBy, filter.sortDir ?? "ASC")
      : 'ORDER BY "created_at" ASC';

  values.push(filter.limit);
  values.push(filter.offset);

  return {
    text: `SELECT * FROM "bets" ${where} ${orderBy} LIMIT $${idx++} OFFSET $${idx++}`,
    values,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Asserts that an identifier (table name, column name) contains only
 * alphanumeric characters and underscores.
 *
 * This guards against second-order injection where a column name constructed
 * from partially-trusted input is used in a quoted identifier.
 */
function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `SQL injection guard: identifier "${name}" contains disallowed characters`
    );
  }
}
