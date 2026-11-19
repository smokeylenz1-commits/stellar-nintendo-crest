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

// Audit log querying API for security auditors.
// Reads from the immutable `audit_logs` table (see migration 0011).
// Supports filtering by actor, action, entity_type, entity_id and time range.
const AUDIT_LOG_MAX_LIMIT = 200;
const AUDIT_LOG_DEFAULT_LIMIT = 50;

function parseAuditLogFilters(query) {
  const filters = {};
  const where = [];
  const params = [];

  const addEq = (column, value) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  };

  addEq('actor', query.actor);
  addEq('action', query.action);
  addEq('entity_type', query.entity_type);
  addEq('entity_id', query.entity_id);

  if (query.from) {
    params.push(query.from);
    where.push(`created_at >= $${params.length}`);
  }
  if (query.to) {
    params.push(query.to);
    where.push(`created_at <= $${params.length}`);
  }

  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = AUDIT_LOG_DEFAULT_LIMIT;
  if (limit > AUDIT_LOG_MAX_LIMIT) limit = AUDIT_LOG_MAX_LIMIT;

  let offset = parseInt(query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  filters.where = where.length ? `WHERE ${where.join(' AND ')}` : '';
  filters.params = params;
  filters.limit = limit;
  filters.offset = offset;
  return filters;
}

app.get('/api/audit-logs', async (req, res, next) => {
  try {
    const db = req.app.get('db');
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const { where, params, limit, offset } = parseAuditLogFilters(req.query);
    const listParams = params.concat([limit, offset]);
    const sql = `
      SELECT id, actor, action, entity_type, entity_id, ip_address, metadata, created_at
      FROM audit_logs
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;

    const { rows } = await db.query(sql, listParams);
    return res.json({ data: rows, limit, offset });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/audit-logs/:id', async (req, res, next) => {
  try {
    const db = req.app.get('db');
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const { rows } = await db.query(
      `SELECT id, actor, action, entity_type, entity_id, ip_address, metadata, created_at
       FROM audit_logs WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Audit log entry not found' });
    }
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = app;
