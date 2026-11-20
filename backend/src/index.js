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
        connectSrc: ["'self'", ...allowedOrigins],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (!parsed || parsed.createdAt === undefined || parsed.id === undefined) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch (err) {
    return null;
  }
}

function parseLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(rawOffset) {
  const parsed = Number.parseInt(rawOffset, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

// Keyset pagination: fetch limit + 1 rows to determine has_more without a count query.
function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
  return { data, next_cursor: nextCursor, has_more: hasMore };
}

// In-memory stores stand in for the database tables; the query helpers below
// mirror the keyset WHERE clauses that would be issued against Postgres.
const markets = [];
const bets = [];

function queryMarkets({ cursor, limit, offset }) {
  let rows = markets.slice().sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
  if (cursor) {
    rows = rows.filter(
      (row) => row.created_at < cursor.createdAt || (row.created_at === cursor.createdAt && row.id < cursor.id)
    );
  } else if (offset > 0) {
    rows = rows.slice(offset);
  }
  return rows.slice(0, limit + 1);
}

function queryBets({ cursor, limit, offset }) {
  let rows = bets.slice().sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });
  if (cursor) {
    rows = rows.filter(
      (row) => row.created_at < cursor.createdAt || (row.created_at === cursor.createdAt && row.id < cursor.id)
    );
  } else if (offset > 0) {
    rows = rows.slice(offset);
  }
  return rows.slice(0, limit + 1);
}

function listHandler(queryFn) {
  return (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);
    const offset = cursor ? 0 : parseOffset(req.query.offset);
    const rows = queryFn({ cursor, limit, offset });
    res.json(paginate(rows, limit));
  };
}

app.get('/api/markets', listHandler(queryMarkets));
app.get('/api/bets', listHandler(queryBets));

// ---------------------------------------------------------------------------
// Tax reporting export (#247)
// ---------------------------------------------------------------------------

// Ledger of capital transactions per user address. Each entry represents a
// taxable event (bet placed, claim, referral reward, or fee) with the USD
// value estimate captured at the time of the transaction.
const taxLedger = [];

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

function normalizeAddress(rawAddress) {
  return typeof rawAddress === 'string' ? rawAddress.trim().toLowerCase() : '';
}

// Streams ledger rows for a single address in chronological order. The
// generator yields one record at a time so large histories never need to be
// buffered fully in memory.
function* streamTaxRecords(address) {
  const target = normalizeAddress(address);
  const rows = taxLedger
    .filter((row) => normalizeAddress(row.address) === target)
    .sort((a, b) => {
      if (a.created_at === b.created_at) return a.id - b.id;
      return a.created_at < b.created_at ? -1 : 1;
    });
  for (const row of rows) {
    yield {
      date: new Date(row.created_at).toISOString(),
      tx_hash: row.tx_hash || '',
      type: row.type || '',
      asset: row.asset || '',
      amount: row.amount !== undefined ? row.amount : '',
      fee: row.fee !== undefined ? row.fee : 0,
      net_payout: row.net_payout !== undefined ? row.net_payout : '',
      usd_value: row.usd_value !== undefined ? row.usd_value : '',
    };
  }
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function writeCsvRecord(res, record) {
  const line = EXPORT_COLUMNS.map((col) => csvEscape(record[col])).join(',') + '\n';
  if (!res.write(line)) {
    return new Promise((resolve) => res.once('drain', resolve));
  }
  return Promise.resolve();
}

app.get('/api/users/:address/export', async (req, res, next) => {
  const format = (req.query.format || 'csv').toString().toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    return res.status(400).json({ error: 'Unsupported format. Use csv or json.' });
  }

  const address = normalizeAddress(req.params.address);
  if (!address) {
    return res.status(400).json({ error: 'Address is required.' });
  }

  const filename = `tax-report-${address}.${format}`;

  try {
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(EXPORT_COLUMNS.join(',') + '\n');
      for (const record of streamTaxRecords(address)) {
        // eslint-disable-next-line no-await-in-loop
        await writeCsvRecord(res, record);
      }
      return res.end();
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write('[');
    let first = true;
    for (const record of streamTaxRecords(address)) {
      const chunk = (first ? '' : ',') + JSON.stringify(record);
      first = false;
      // eslint-disable-next-line no-await-in-loop
      if (!res.write(chunk)) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.write(']');
    return res.end();
  } catch (err) {
    return next(err);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
