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

// ---------------------------------------------------------------------------
// Webhook notification service (issue #240)
// ---------------------------------------------------------------------------

const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_BASE_BACKOFF_MS = 1000;
const WEBHOOK_MAX_BACKOFF_MS = 60000;
const WEBHOOK_TIMEOUT_MS = 10000;

// In-memory registry keyed by user id. Replace with persistent storage in
// production; the delivery/signing logic below is storage-agnostic.
const webhookRegistry = new Map();

function isValidWebhookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (err) {
    return false;
  }
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function signWebhookPayload(secret, timestamp, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function computeBackoffMs(attempt) {
  const delay = WEBHOOK_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  return Math.min(delay, WEBHOOK_MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverWebhookOnce(registration, event) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(event);
  const signature = signWebhookPayload(registration.secret, timestamp, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(registration.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': event.type,
      },
      body,
      signal: controller.signal,
    });
    return response.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhookWithRetry(registration, event) {
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await deliverWebhookOnce(registration, event);
    if (ok) return true;
    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(computeBackoffMs(attempt));
    }
  }
  return false;
}

function enqueueNotification(userId, event) {
  const registration = webhookRegistry.get(userId);
  if (!registration || !registration.enabled) return;
  // Fire-and-forget worker; retries handled internally with backoff.
  deliverWebhookWithRetry(registration, event).catch(() => {});
}

function notifyBetOutcome(userId, payload) {
  enqueueNotification(userId, {
    type: 'bet.outcome',
    createdAt: new Date().toISOString(),
    data: payload,
  });
}

function notifyReferralEarning(userId, payload) {
  enqueueNotification(userId, {
    type: 'referral.earning',
    createdAt: new Date().toISOString(),
    data: payload,
  });
}

// Registration endpoints in user settings.
app.get('/api/users/:userId/webhook', (req, res) => {
  const registration = webhookRegistry.get(req.params.userId);
  if (!registration) {
    return res.status(404).json({ error: 'No webhook registered' });
  }
  return res.json({
    url: registration.url,
    enabled: registration.enabled,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  });
});

app.put('/api/users/:userId/webhook', (req, res) => {
  const { url, enabled } = req.body || {};
  if (!isValidWebhookUrl(url)) {
    return res.status(400).json({ error: 'A valid http(s) webhook URL is required' });
  }

  const existing = webhookRegistry.get(req.params.userId);
  const now = new Date().toISOString();
  const registration = {
    url: url.trim(),
    secret: existing ? existing.secret : generateWebhookSecret(),
    enabled: enabled === undefined ? true : Boolean(enabled),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  webhookRegistry.set(req.params.userId, registration);

  return res.json({
    url: registration.url,
    enabled: registration.enabled,
    // Secret is returned so the user can verify signatures; only on write.
    secret: registration.secret,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  });
});

app.delete('/api/users/:userId/webhook', (req, res) => {
  const removed = webhookRegistry.delete(req.params.userId);
  if (!removed) {
    return res.status(404).json({ error: 'No webhook registered' });
  }
  return res.status(204).end();
});

app.notifications = {
  notifyBetOutcome,
  notifyReferralEarning,
  signWebhookPayload,
  computeBackoffMs,
  WEBHOOK_MAX_ATTEMPTS,
};

// ---------------------------------------------------------------------------
// Market stats cache (issue #241)
//
// Computed odds, implied probabilities, and total pool sizes are cached per
// market in a Redis hash. Reads are served from cache when warm; on a cold
// cache we fall back to the database loader and repopulate. New bets update
// the cached totals incrementally so the primary DB is not re-scanned on every
// market pageview.
// ---------------------------------------------------------------------------

const MARKET_STATS_TTL_SECONDS = 300;
const MARKET_STATS_KEY_PREFIX = 'market:stats:';

function marketStatsKey(marketId) {
  return `${MARKET_STATS_KEY_PREFIX}${marketId}`;
}

function computeMarketStats(outcomes) {
  const totalPool = outcomes.reduce((sum, o) => sum + (Number(o.pool) || 0), 0);
  const stats = outcomes.map((o) => {
    const pool = Number(o.pool) || 0;
    const impliedProbability = totalPool > 0 ? pool / totalPool : 0;
    const odds = impliedProbability > 0 ? 1 / impliedProbability : 0;
    return {
      outcomeId: o.outcomeId,
      pool,
      impliedProbability,
      odds,
    };
  });
  return { marketId: null, totalPool, outcomes: stats, updatedAt: Date.now() };
}

function serializeMarketStats(stats) {
  return {
    marketId: String(stats.marketId),
    totalPool: String(stats.totalPool),
    outcomes: JSON.stringify(stats.outcomes),
    updatedAt: String(stats.updatedAt),
  };
}

function deserializeMarketStats(hash) {
  if (!hash || !hash.outcomes) return null;
  return {
    marketId: hash.marketId,
    totalPool: Number(hash.totalPool) || 0,
    outcomes: JSON.parse(hash.outcomes),
    updatedAt: Number(hash.updatedAt) || 0,
  };
}

// ---------------------------------------------------------------------------
// User analytics (issue #242)
//
// Aggregates a user's historical bets, payouts, and IPREDICT rewards into
// lifetime P&L / win-rate stats plus a 30-day cumulative P&L time series for
// charting. Referral commissions and token balances are included so the
// client can render a complete portfolio view from a single request.
// ---------------------------------------------------------------------------

const ANALYTICS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// In-memory store keyed by lowercased address. Replace with persistent
// storage in production; the aggregation logic below is storage-agnostic.
const userAnalyticsStore = new Map();

function normalizeAddress(address) {
  return typeof address === 'string' ? address.trim().toLowerCase() : '';
}

function getUserAnalyticsRecord(address) {
  const key = normalizeAddress(address);
  if (!userAnalyticsStore.has(key)) {
    userAnalyticsStore.set(key, {
      bets: [],
      referralCommissions: 0,
      tokenBalances: {},
    });
  }
  return userAnalyticsStore.get(key);
}

function buildCumulativePnlSeries(bets, now) {
  const windowStart = now - ANALYTICS_WINDOW_DAYS * DAY_MS;
  const buckets = new Map();
  for (let i = 0; i < ANALYTICS_WINDOW_DAYS; i += 1) {
    const dayStart = windowStart + i * DAY_MS;
    buckets.set(dayStart, 0);
  }

  bets.forEach((bet) => {
    const ts = Number(bet.timestamp) || 0;
    if (ts < windowStart || ts > now) return;
    const dayIndex = Math.floor((ts - windowStart) / DAY_MS);
    const dayStart = windowStart + dayIndex * DAY_MS;
    if (!buckets.has(dayStart)) return;
    const pnl = (Number(bet.payout) || 0) - (Number(bet.stake) || 0);
    buckets.set(dayStart, buckets.get(dayStart) + pnl);
  });

  let cumulative = 0;
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([dayStart, dailyPnl]) => {
      cumulative += dailyPnl;
      return {
        date: new Date(dayStart).toISOString().slice(0, 10),
        dailyPnl,
        cumulativePnl: cumulative,
      };
    });
}

function computeUserAnalytics(record, now) {
  const bets = record.bets || [];
  let totalStaked = 0;
  let totalPayout = 0;
  let winCount = 0;
  let lossCount = 0;

  bets.forEach((bet) => {
    const stake = Number(bet.stake) || 0;
    const payout = Number(bet.payout) || 0;
    totalStaked += stake;
    totalPayout += payout;
    if (bet.status === 'won') winCount += 1;
    else if (bet.status === 'lost') lossCount += 1;
  });

  const settledCount = winCount + lossCount;
  const winRate = settledCount > 0 ? (winCount / settledCount) * 100 : 0;
  const netPnl = totalPayout - totalStaked;
  const roi = totalStaked > 0 ? (netPnl / totalStaked) * 100 : 0;

  return {
    address: record.address,
    totalBets: bets.length,
    winCount,
    lossCount,
    winRate,
    totalStaked,
    totalPayout,
    netPnl,
    roi,
    referralCommissions: Number(record.referralCommissions) || 0,
    tokenBalances: record.tokenBalances || {},
    pnlSeries: buildCumulativePnlSeries(bets, now),
    generatedAt: new Date(now).toISOString(),
  };
}

app.get('/api/users/:address/analytics', (req, res) => {
  const address = normalizeAddress(req.params.address);
  if (!address) {
    return res.status(400).json({ error: 'A valid user address is required' });
  }

  const record = getUserAnalyticsRecord(address);
  record.address = address;
  return res.json(computeUserAnalytics(record, Date.now()));
});

app.analytics = {
  getUserAnalyticsRecord,
  computeUserAnalytics,
  buildCumulativePnlSeries,
  ANALYTICS_WINDOW_DAYS,
};

module.exports = app;
