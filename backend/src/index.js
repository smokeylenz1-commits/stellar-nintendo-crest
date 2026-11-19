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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Webhook notification service (issue #240)
// ---------------------------------------------------------------------------

const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const WEBHOOK_TIMEOUT_MS = 10000;

// In-memory registry of user webhook settings keyed by userId.
// { url, secret, active }
const webhookSettings = new Map();

function isValidWebhookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (err) {
    return false;
  }
}

function signPayload(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function backoffDelay(attempt) {
  // attempt is 1-based; exponential backoff: 1s, 2s, 4s, 8s, 16s
  return BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverOnce(url, body, signature) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Signature-Algorithm': 'hmac-sha256',
      },
      body,
      signal: controller.signal,
    });
    return response.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function deliverWebhook(userId, event) {
  const settings = webhookSettings.get(userId);
  if (!settings || !settings.active || !settings.url) {
    return { delivered: false, reason: 'no-active-webhook' };
  }

  const body = JSON.stringify({
    event: event.type,
    userId,
    data: event.data,
    timestamp: new Date().toISOString(),
  });
  const signature = signPayload(settings.secret, body);

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    const ok = await deliverOnce(settings.url, body, signature);
    if (ok) {
      return { delivered: true, attempts: attempt };
    }
    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      await sleep(backoffDelay(attempt));
    }
  }

  return { delivered: false, attempts: MAX_DELIVERY_ATTEMPTS, reason: 'max-retries-exceeded' };
}

// Fire-and-forget notification triggers used by bet/referral flows.
function notifyBetOutcome(userId, outcome) {
  return deliverWebhook(userId, { type: 'bet.outcome', data: outcome });
}

function notifyReferralEarning(userId, earning) {
  return deliverWebhook(userId, { type: 'referral.earning', data: earning });
}

// --- Webhook registration endpoints (user settings) ---

app.get('/api/users/:userId/webhook', (req, res) => {
  const settings = webhookSettings.get(req.params.userId);
  if (!settings) {
    return res.status(404).json({ error: 'No webhook registered' });
  }
  return res.json({
    url: settings.url,
    active: settings.active,
    hasSecret: Boolean(settings.secret),
  });
});

app.put('/api/users/:userId/webhook', (req, res) => {
  const { url, secret, active } = req.body || {};
  if (!isValidWebhookUrl(url)) {
    return res.status(400).json({ error: 'A valid http(s) webhook url is required' });
  }
  if (secret !== undefined && (typeof secret !== 'string' || secret.length < 16)) {
    return res.status(400).json({ error: 'Secret must be a string of at least 16 characters' });
  }

  const existing = webhookSettings.get(req.params.userId);
  const resolvedSecret = secret || (existing && existing.secret) || crypto.randomBytes(32).toString('hex');

  webhookSettings.set(req.params.userId, {
    url,
    secret: resolvedSecret,
    active: active === undefined ? true : Boolean(active),
  });

  return res.json({
    url,
    active: active === undefined ? true : Boolean(active),
    secret: resolvedSecret,
  });
});

app.delete('/api/users/:userId/webhook', (req, res) => {
  const removed = webhookSettings.delete(req.params.userId);
  if (!removed) {
    return res.status(404).json({ error: 'No webhook registered' });
  }
  return res.status(204).end();
});

app.locals.notifications = {
  deliverWebhook,
  notifyBetOutcome,
  notifyReferralEarning,
  signPayload,
};

module.exports = app;
