const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');

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

function sendError(res, statusCode, code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return res.status(statusCode).json({ success: false, error });
}

// ---------------------------------------------------------------------------
// Admin RBAC + audit log
// ---------------------------------------------------------------------------

const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  MARKET_CREATOR: 'MarketCreator',
  COUNCIL_MEMBER: 'CouncilMember',
});

// Role assignments are sourced from configuration (comma-separated
// `role:wallet` pairs) so operators can manage admins without code changes.
function loadRoleAssignments() {
  const assignments = new Map();
  const raw = process.env.ADMIN_ROLE_ASSIGNMENTS || '';
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [role, wallet] = entry.split(':').map((part) => (part || '').trim());
      if (!role || !wallet || !Object.values(ADMIN_ROLES).includes(role)) {
        return;
      }
      const normalized = wallet.toLowerCase();
      const roles = assignments.get(normalized) || new Set();
      roles.add(role);
      assignments.set(normalized, roles);
    });
  return assignments;
}

const roleAssignments = loadRoleAssignments();

// In-memory audit log. Each entry records the administrative action, the
// caller identity, and a timestamp. Swap for a persistent table when a DB
// layer is available; the shape is intentionally table-friendly.
const auditLog = [];

function recordAudit({ action, caller, roles, target, outcome, details }) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    caller: caller || null,
    roles: roles || [],
    target: target || null,
    outcome: outcome || 'success',
    details: details || null,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(entry);
  return entry;
}

function getRolesForWallet(wallet) {
  if (!wallet) {
    return [];
  }
  const roles = roleAssignments.get(String(wallet).toLowerCase());
  return roles ? Array.from(roles) : [];
}

// Verifies the admin wallet signature. The caller supplies `x-admin-wallet`,
// `x-admin-timestamp`, and `x-admin-signature` (hex HMAC-SHA256 over
// `${timestamp}.${method}.${path}` keyed by ADMIN_SIGNATURE_SECRET). This
// mirrors the oracle-auth signature pattern used elsewhere in the backend.
function verifyAdminSignature(req) {
  const wallet = req.get('x-admin-wallet');
  const timestamp = req.get('x-admin-timestamp');
  const signature = req.get('x-admin-signature');
  const secret = process.env.ADMIN_SIGNATURE_SECRET;

  if (!wallet || !timestamp || !signature) {
    return { ok: false, code: 'ADMIN_AUTH_MISSING', message: 'Admin authentication headers are required' };
  }
  if (!secret) {
    return { ok: false, code: 'ADMIN_AUTH_UNCONFIGURED', message: 'Admin signature verification is not configured' };
  }

  const ts = Number(timestamp);
  const maxSkewMs = Number(process.env.ADMIN_SIGNATURE_MAX_SKEW_MS) || 5 * 60 * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) {
    return { ok: false, code: 'ADMIN_AUTH_EXPIRED', message: 'Admin signature timestamp is invalid or expired' };
  }

  const payload = `${timestamp}.${req.method}.${req.baseUrl}${req.path}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const provided = String(signature).toLowerCase();
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return { ok: false, code: 'ADMIN_AUTH_INVALID', message: 'Admin signature verification failed' };
  }

  return { ok: true, wallet: String(wallet).toLowerCase() };
}

// RBAC middleware factory: authenticates the admin wallet, resolves its roles,
// and enforces that at least one of the allowed roles is present.
function requireAdminRole(allowedRoles) {
  return function adminRbac(req, res, next) {
    const auth = verifyAdminSignature(req);
    if (!auth.ok) {
      recordAudit({
        action: `${req.method} ${req.baseUrl}${req.path}`,
        caller: req.get('x-admin-wallet') || null,
        outcome: 'denied',
        details: { reason: auth.code },
      });
      return sendError(res, 401, auth.code, auth.message);
    }

    const roles = getRolesForWallet(auth.wallet);
    if (roles.length === 0) {
      recordAudit({
        action: `${req.method} ${req.baseUrl}${req.path}`,
        caller: auth.wallet,
        outcome: 'denied',
        details: { reason: 'ADMIN_ROLE_MISSING' },
      });
      return sendError(res, 403, 'ADMIN_ROLE_MISSING', 'Caller has no administrative role');
    }

    const permitted = roles.some((role) => allowedRoles.includes(role));
    if (!permitted) {
      recordAudit({
        action: `${req.method} ${req.baseUrl}${req.path}`,
        caller: auth.wallet,
        roles,
        outcome: 'denied',
        details: { reason: 'ADMIN_ROLE_FORBIDDEN', allowedRoles },
      });
      return sendError(res, 403, 'ADMIN_ROLE_FORBIDDEN', 'Caller role is not permitted for this action', {
        allowedRoles,
      });
    }

    req.admin = { wallet: auth.wallet, roles };
    return next();
  };
}

// ---------------------------------------------------------------------------
// Health / readiness probes for orchestration (Kubernetes, Docker)
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 2000;

// Wraps a dependency check with a timeout so a hung dependency cannot stall
// the probe. Resolves to a normalized { status, latencyMs, ... } report.
async function runHealthCheck(name, checkFn) {
  const startedAt = process.hrtime.bigint();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(checkFn),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${HEALTH_TIMEOUT_MS}ms`)),
          HEALTH_TIMEOUT_MS
        );
      }),
    ]);
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { name, status: 'up', latencyMs: Math.round(latencyMs * 100) / 100, ...(result || {}) };
  } catch (err) {
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
      name,
      status: 'down',
      latencyMs: Math.round(latencyMs * 100) / 100,
      error: err && err.message ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// PostgreSQL ping. Uses `pg` when available; otherwise reports the dependency
// as unconfigured so the probe still returns a structured report.
async function checkPostgres() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return { status: 'down', error: 'DATABASE_URL is not configured' };
  }
  let pg;
  try {
    // eslint-disable-next-line global-require
    pg = require('pg');
  } catch (err) {
    return { status: 'down', error: 'pg driver is not installed' };
  }
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: HEALTH_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { status: 'up' };
  } finally {
    await client.end().catch(() => {});
  }
}

// Redis ping. Uses `redis` when available; otherwise reports unconfigured.
async function checkRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return { status: 'down', error: 'REDIS_URL is not configured' };
  }
  let redis;
  try {
    // eslint-disable-next-line global-require
    redis = require('redis');
  } catch (err) {
    return { status: 'down', error: 'redis driver is not installed' };
  }
  const client = redis.createClient({ url: redisUrl });
  client.on('error', () => {});
  try {
    await client.connect();
    const pong = await client.ping();
    return { status: pong === 'PONG' ? 'up' : 'down', detail: pong };
  } finally {
    await client.quit().catch(() => {});
  }
}

// Soroban RPC block height. Queries the RPC `getLatestLedger` method.
async function checkSorobanRpc() {
  const rpcUrl = process.env.SOROBAN_RPC_URL;
  if (!rpcUrl) {
    return { status: 'down', error: 'SOROBAN_RPC_URL is not configured' };
  }
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger', params: {} }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'down', error: `RPC responded with HTTP ${response.status}` };
    }
    const payload = await response.json();
    if (payload && payload.error) {
      return { status: 'down', error: payload.error.message || 'RPC error' };
    }
    const blockHeight = payload && payload.result ? payload.result.sequence : undefined;
    if (blockHeight === undefined) {
      return { status: 'down', error: 'RPC response missing ledger sequence' };
    }
    return { status: 'up', blockHeight };
  } finally {
    clearTimeout(abortTimer);
  }
}

// Liveness: cheap, no dependency queries. Must respond in sub-10ms.
app.get('/health/liveness', (req, res) => {
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness: verifies all downstream dependencies within the timeout window.
app.get('/health/readiness', async (req, res) => {
  const checks = await Promise.all([
    runHealthCheck('postgres', checkPostgres),
    runHealthCheck('redis', checkRedis),
    runHealthCheck('sorobanRpc', checkSorobanRpc),
  ]);

  const subsystems = {};
  let healthy = true;
  checks.forEach((check) => {
    subsystems[check.name] = check;
    if (check.status !== 'up') {
      healthy = false;
    }
  });

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    subsystems,
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Admin: manual market seeding (MarketCreator or SuperAdmin).
app.post(
  '/api/admin/markets/seed',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.MARKET_CREATOR]),
  (req, res) => {
    const { marketId, question, resolutionDate } = req.body || {};
    if (!marketId || !question) {
      recordAudit({
        action: 'market.seed',
        caller: req.admin.wallet,
        roles: req.admin.roles,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'marketId and question are required');
    }

    const entry = recordAudit({
      action: 'market.seed',
      caller: req.admin.wallet,
      roles: req.admin.roles,
      target: marketId,
      details: { question, resolutionDate: resolutionDate || null },
    });

    return res.status(201).json({
      success: true,
      data: { marketId, question, resolutionDate: resolutionDate || null, auditId: entry.id },
    });
  }
);

// Admin: resolution override (SuperAdmin or CouncilMember).
app.post(
  '/api/admin/markets/:marketId/resolv

/* … truncated 2351 chars — edit only what you need near the top … */
