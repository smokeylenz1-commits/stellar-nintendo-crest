const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { run: runMigrations } = require('./db/migrate');

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function getAuditDb() {
  // Lazy require so the API can boot without a DB in non-DB environments.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  if (!getAuditDb.pool) {
    getAuditDb.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return getAuditDb.pool;
}

function requireAuditor(req, res, next) {
  const expected = process.env.AUDIT_API_TOKEN;
  const provided = req.get('authorization') || '';
  const token = provided.startsWith('Bearer ') ? provided.slice(7) : '';
  if (!expected || token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

// Read-only querying API for security auditors over the immutable audit_logs table.
app.get('/audit-logs', requireAuditor, async (req, res) => {
  const { actor, action, entity_type: entityType, entity_id: entityId } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const clauses = [];
  const params = [];
  const addFilter = (column, value) => {
    if (value !== undefined && value !== '') {
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
  };
  addFilter('actor', actor);
  addFilter('action', action);
  addFilter('entity_type', entityType);
  addFilter('entity_id', entityId);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const sql = `SELECT id, actor, action, entity_type, entity_id, ip_address, metadata, created_at
    FROM audit_logs ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  try {
    const { rows } = await getAuditDb().query(sql, params);
    res.json({ data: rows, limit, offset });
  } catch (err) {
    console.error('[api] audit-logs query failed:', err.message);
    res.status(500).json({ error: 'query_failed' });
  }
});

async function start() {
  if (process.env.DATABASE_URL) {
    await runMigrations({ direction: 'up' });
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[api] listening on ${port}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[api] failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = app;
