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

// Uniform error envelope: { success: false, error: { code, message, details } }
function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return res.status(status).json({ success: false, error });
}

// ---------------------------------------------------------------------------
// Health / readiness probes (issue #245)
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS) || 2000;

// Wrap a dependency check so it can never hang the probe: resolves to a
// structured status object within HEALTH_TIMEOUT_MS.
function withTimeout(name, checkFn) {
  return new Promise((resolve) => {
    let settled = false;
    const startedAt = Date.now();
    const finish = (status, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name,
        status,
        latencyMs: Date.now() - startedAt,
        ...(extra || {}),
      });
    };

    const timer = setTimeout(() => {
      finish('down', { error: `timeout after ${HEALTH_TIMEOUT_MS}ms` });
    }, HEALTH_TIMEOUT_MS);

    Promise.resolve()
      .then(() => checkFn())
      .then((extra) => finish('up', extra))
      .catch((err) => finish('down', { error: err && err.message ? err.message : String(err) }));
  });
}

// PostgreSQL ping. Uses a pluggable `dbPing` handler registered on the app so
// the concrete pool/query can be wired in without coupling this module.
async function checkPostgres() {
  const ping = app.get('dbPing');
  if (typeof ping !== 'function') {
    throw new Error('dbPing handler not configured');
  }
  await ping();
  return {};
}

// Redis ping. Uses a pluggable `redisPing` handler registered on the app.
async function checkRedis() {
  const ping = app.get('redisPing');
  if (typeof ping !== 'function') {
    throw new Error('redisPing handler not configured');
  }
  await ping();
  return {};
}

// Soroban RPC block height. Uses a pluggable `sorobanBlockHeight` handler.
async function checkSoroban() {
  const getHeight = app.get('sorobanBlockHeight');
  if (typeof getHeight !== 'function') {
    throw new Error('sorobanBlockHeight handler not configured');
  }
  const blockHeight = await getHeight();
  return { blockHeight };
}

// Liveness: cheap, no dependency queries. Must respond in sub-10ms.
app.get('/health/liveness', (req, res) => {
  return res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Readiness: checks PostgreSQL, Redis, and Soroban RPC. Returns 200 only when
// every subsystem is up; 503 otherwise.
app.get('/health/readiness', async (req, res) => {
  const checks = await Promise.all([
    withTimeout('postgres', checkPostgres),
    withTimeout('redis', checkRedis),
    withTimeout('soroban', checkSoroban),
  ]);

  const subsystems = {};
  let healthy = true;
  for (const check of checks) {
    subsystems[check.name] = check;
    if (check.status !== 'up') {
      healthy = false;
    }
  }

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    subsystems,
  });
});

// ---------------------------------------------------------------------------
// Admin RBAC + audit log (issue #244)
// ---------------------------------------------------------------------------

const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  MARKET_CREATOR: 'MarketCreator',
  COUNCIL_MEMBER: 'CouncilMember',
});

// Role assignments are configured out-of-band via env, e.g.
// ADMIN_ROLE_MAP='{"GABC...":"SuperAdmin","GDEF...":"MarketCreator"}'
function loadRoleMap() {
  const raw = process.env.ADMIN_ROLE_MAP;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin] Failed to parse ADMIN_ROLE_MAP', err);
    return {};
  }
}

const adminRoleMap = loadRoleMap();

// In-memory audit log. Each entry records the administrative action, the
// caller identity, and a timestamp. Persist to durable storage in production.
const adminAuditLog = [];

function recordAudit({ action, caller, role, target, outcome, details }) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    caller: caller || null,
    role: role || null,
    target: target || null,
    outcome: outcome || 'success',
    details: details || null,
    timestamp: new Date().toISOString(),
  };
  adminAuditLog.push(entry);
  return entry;
}

// Verify the admin wallet signature. The caller supplies the wallet address in
// `x-admin-wallet` and a signature over the canonical request payload in
// `x-admin-signature`. Signature verification is delegated to a pluggable
// verifier so the concrete crypto scheme can be wired in without changing the
// middleware contract.
function verifyAdminSignature(req) {
  const wallet = req.get('x-admin-wallet');
  const signature = req.get('x-admin-signature');
  if (!wallet || !signature) {
    return { ok: false, code: 'MISSING_ADMIN_CREDENTIALS' };
  }

  const verifier = app.get('adminSignatureVerifier');
  if (typeof verifier !== 'function') {
    return { ok: false, code: 'ADMIN_VERIFIER_UNAVAILABLE' };
  }

  const message = `${req.method} ${req.originalUrl}`;
  let valid = false;
  try {
    valid = verifier({ wallet, signature, message }) === true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[admin] Signature verifier threw', err);
    valid = false;
  }

  if (!valid) {
    return { ok: false, code: 'INVALID_ADMIN_SIGNATURE' };
  }
  return { ok: true, wallet };
}

// RBAC middleware factory: authenticates the wallet signature, resolves the
// caller's role, and enforces that the role is in the allowed set.
function requireAdminRole(allowedRoles) {
  return function adminRbac(req, res, next) {
    const auth = verifyAdminSignature(req);
    if (!auth.ok) {
      recordAudit({
        action: `${req.method} ${req.originalUrl}`,
        caller: req.get('x-admin-wallet') || null,
        outcome: 'denied',
        details: { reason: auth.code },
      });
      return sendError(res, 401, auth.code, 'Admin authentication failed');
    }

    const role = adminRoleMap[auth.wallet];
    if (!role) {
      recordAudit({
        action: `${req.method} ${req.originalUrl}`,
        caller: auth.wallet,
        outcome: 'denied',
        details: { reason: 'NO_ROLE_ASSIGNED' },
      });
      return sendError(res, 403, 'FORBIDDEN', 'Caller has no administrative role');
    }

    if (!allowedRoles.includes(role)) {
      recordAudit({
        action: `${req.method} ${req.originalUrl}`,
        caller: auth.wallet,
        role,
        outcome: 'denied',
        details: { reason: 'INSUFFICIENT_ROLE', allowedRoles },
      });
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient role for this action', {
        required: allowedRoles,
      });
    }

    req.admin = { wallet: auth.wallet, role };
    return next();
  };
}

// Manual market seeding (MarketCreator / SuperAdmin).
app.post(
  '/api/admin/markets/seed',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.MARKET_CREATOR]),
  (req, res) => {
    const { marketId, question, resolutionTime } = req.body || {};
    if (!marketId || !question) {
      recordAudit({
        action: 'market.seed',
        caller: req.admin.wallet,
        role: req.admin.role,
        target: marketId || null,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'marketId and question are required');
    }

    const entry = recordAudit({
      action: 'market.seed',
      caller: req.admin.wallet,
      role: req.admin.role,
      target: marketId,
      details: { question, resolutionTime: resolutionTime || null },
    });

    return res.status(201).json({
      success: true,
      data: { marketId, seededBy: req.admin.wallet, auditId: entry.id },
    });
  }
);

// Resolution override (SuperAdmin / CouncilMember).
app.post(
  '/api/admin/markets/:marketId/resolve',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN, ADMIN_ROLES.COUNCIL_MEMBER]),
  (req, res) => {
    const { marketId } = req.params;
    const { outcome, reason } = req.body || {};
    if (!outcome) {
      recordAudit({
        action: 'market.resolve.override',
        caller: req.admin.wallet,
        role: req.admin.role,
        target: marketId,
        outcome: 'rejected',
        details: { reason: 'VALIDATION_FAILED' },
      });
      return sendError(res, 400, 'VALIDATION_FAILED', 'outcome is required');
    }

    const entry = recordAudit({
      action: 'market.resolve.override',
      caller: req.admin.wallet,
      role: req.admin.role,
      target: marketId,
      details: { outcome, reason: reason || null },
    });

    return res.status(200).json({
      success: true,
      data: { marketId, outcome, overriddenBy: req.admin.wallet, auditId: entry.id },
    });
  }
);

// Audit log inspection (SuperAdmin only).
app.get(
  '/api/admin/audit-log',
  requireAdminRole([ADMIN_ROLES.SUPER_ADMIN]),
  (req, res) => {
    return res.status(200).json({ success: true, data: adminAuditLog });
  }
);

// 404 handler: unmatched routes conform to the uniform envelope.
app.use((req, res) => {
  return sendError(res, 404, 'NOT_FOUND', 'Resource not found');
});

module.exports = app;
