const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://app.example.com,https://www.example.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://trusted-cdn.example.com'],
        connectSrc: ["'self'", 'https://api.example.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  })
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Cursor-based pagination helpers (issue #234)
//
// Composite keyset cursor over (created_at, id). The cursor is base64-encoded
// JSON so it is opaque to clients. Keyset WHERE clauses keep queries fast on
// large tables and stable under concurrent inserts, unlike OFFSET.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function encodeCursor(row) {
  if (!row || row.created_at == null || row.id == null) return null;
  const payload = JSON.stringify({ created_at: row.created_at, id: row.id });
  return Buffer.from(payload, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (parsed && parsed.created_at != null && parsed.id != null) {
      return { created_at: parsed.created_at, id: parsed.id };
    }
  } catch (err) {
    // Malformed cursor: fall back to first page rather than erroring.
  }
  return null;
}

function parseLimit(rawLimit) {
  const parsed = parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

// Builds a keyset WHERE fragment + params for descending (created_at, id)
// ordering. Returns null when no cursor is supplied (first page).
function buildKeysetClause(cursor) {
  if (!cursor) return null;
  return {
    clause: '(created_at, id) < (?, ?)',
    params: [cursor.created_at, cursor.id],
  };
}

// Runs a paginated query against a table using keyset pagination. `db` is a
// promise-based query function: (sql, params) => Promise<rows>.
async function paginate(db, table, { cursor, limit }) {
  const pageSize = parseLimit(limit);
  const decoded = decodeCursor(cursor);
  const keyset = buildKeysetClause(decoded);

  const where = keyset ? `WHERE ${keyset.clause}` : '';
  const params = keyset ? keyset.params.slice() : [];
  // Fetch one extra row to determine has_more without a COUNT query.
  params.push(pageSize + 1);

  const sql = `SELECT * FROM ${table} ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rows = await db(sql, params);

  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore ? encodeCursor(data[data.length - 1]) : null;

  return { data, next_cursor: nextCursor, has_more: hasMore };
}

// Legacy offset/limit pagination, retained for backwards compatibility.
async function paginateLegacy(db, table, { offset, limit }) {
  const pageSize = parseLimit(limit);
  const parsedOffset = parseInt(offset, 10);
  const skip = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  const sql = `SELECT * FROM ${table} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const rows = await db(sql, [pageSize + 1, skip]);

  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore ? encodeCursor(data[data.length - 1]) : null;

  return { data, next_cursor: nextCursor, has_more: hasMore };
}

// Resolves the pagination strategy from query params. A `cursor` param takes
// precedence; otherwise legacy `offset`/`limit` params are honored.
async function paginateResource(db, table, query) {
  const { cursor, offset, limit } = query || {};
  if (cursor) {
    return paginate(db, table, { cursor, limit });
  }
  if (offset != null) {
    return paginateLegacy(db, table, { offset, limit });
  }
  return paginate(db, table, { cursor: null, limit });
}

app.get('/api/markets', async (req, res, next) => {
  try {
    const result = await paginateResource(req.app.locals.db, 'markets', req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get('/api/bets', async (req, res, next) => {
  try {
    const result = await paginateResource(req.app.locals.db, 'bets', req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Tax reporting export (issue #247)
//
// Streams an itemized ledger of a user's capital transactions (bets, claims,
// referral rewards, fees) as CSV (CoinTracker/Koinly compatible) or JSON.
// Rows are pulled in keyset-paginated batches and written to the response as
// they arrive so large histories never buffer fully in memory.
// ---------------------------------------------------------------------------

const EXPORT_BATCH_SIZE = 500;
const EXPORT_COLUMNS = [
  'date',
  'tx_hash',
  'type',
  'asset',
  'amount',
  'fee',
  'net_payout',
  'usd_value',
];

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeExportRow(row) {
  return {
    date: row.created_at != null ? new Date(row.created_at).toISOString() : '',
    tx_hash: row.tx_hash || '',
    type: row.type || '',
    asset: row.asset || '',
    amount: row.amount != null ? row.amount : '',
    fee: row.fee != null ? row.fee : 0,
    net_payout: row.net_payout != null ? row.net_payout : '',
    usd_value: row.usd_value != null ? row.usd_value : '',
  };
}

async function streamExport(req, res, next) {
  const { address } = req.params;
  const format = String(req.query.format || 'csv').toLowerCase();

  if (format !== 'csv' && format !== 'json') {
    return res.status(400).json({ error: "Unsupported format. Use 'csv' or 'json'." });
  }

  const db = req.app.locals.db;
  const isCsv = format === 'csv';

  res.setHeader('Content-Type', isCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${address}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (isCsv) {
      res.write(`${EXPORT_COLUMNS.join(',')}\n`);
    } else {
      res.write('[');
    }

    let cursor = null;
    let first = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const keyset = buildKeysetClause(cursor);
      const where = keyset
        ? `WHERE address = ? AND ${keyset.clause}`
        : 'WHERE address = ?';
      const params = keyset ? [address, ...keyset.params] : [address];
      params.push(EXPORT_BATCH_SIZE);

      const sql = `SELECT * FROM transactions ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
      const rows = await db(sql, params);

      if (!rows || rows.length === 0) break;

      for (const raw of rows) {
        const row = normalizeExportRow(raw);
        if (isCsv) {
          res.write(`${EXPORT_COLUMNS.map((col) => csvEscape(row[col])).join(',')}\n`);
        } else {
          res.write(`${first ? '' : ','}${JSON.stringify(row)}`);
          first = false;
        }
      }

      if (rows.length < EXPORT_BATCH_SIZE) break;
      cursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
    }

    if (!isCsv) {
      res.write(']');
    }
    res.end();
  } catch (err) {
    // If headers already sent we cannot switch to a JSON error response.
    if (res.headersSent) {
      res.end();
      return;
    }
    next(err);
  }
}

app.get('/api/users/:address/export', streamExport);

module.exports = app;
module.exports.encodeCursor = encodeCursor;
module.exports.decodeCursor = decodeCursor;
module.exports.paginateResource = paginateResource;
