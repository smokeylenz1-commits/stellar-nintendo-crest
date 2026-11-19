const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const swaggerUi = require('swagger-ui-express');

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

// --- OpenAPI / Swagger documentation (issue #236) ---
// OpenAPI 3.1 specification describing the public API surface. Route-level
// schemas are merged in via `registerRouteSchema` so the spec stays in sync
// with the actual handlers.
const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Handsoff API',
    version: process.env.npm_package_version || '1.0.0',
    description: 'Automated OpenAPI documentation for the Handsoff backend.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      indexerToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-indexer-token',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          retryAfter: { type: 'integer' },
        },
        required: ['error'],
      },
    },
  },
  paths: {},
};

function registerRouteSchema(path, method, schema) {
  if (!openApiSpec.paths[path]) {
    openApiSpec.paths[path] = {};
  }
  openApiSpec.paths[path][method.toLowerCase()] = schema;
}

app.get('/api/docs/json', (req, res) => {
  res.json(openApiSpec);
});

app.use(
  '/api/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    swaggerOptions: { url: '/api/docs/json' },
  })
);

// --- Tiered rate limiting (issue #235) ---
// Shared Redis-backed store so limits are enforced across all instances.
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});
redisClient.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[rate-limit] redis error', err.message);
});
redisClient.connect().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[rate-limit] redis connect failed', err.message);
});

const PUBLIC_LIMIT = Number(process.env.RATE_LIMIT_PUBLIC || 60);
const AUTH_LIMIT = Number(process.env.RATE_LIMIT_AUTH || 300);
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);

const whitelistedIps = (process.env.RATE_LIMIT_WHITELIST_IPS || '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

const trustedIndexerTokens = (process.env.RATE_LIMIT_INDEXER_TOKENS || '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);

function getClientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isWhitelisted(req) {
  if (whitelistedIps.includes(getClientIp(req))) {
    return true;
  }
  const indexerToken = req.get('x-indexer-token');
  if (indexerToken && trustedIndexerTokens.includes(indexerToken)) {
    return true;
  }
  return false;
}

function getWalletAddress(req) {
  // Authenticated requests are keyed by wallet address when available.
  return req.user && (req.user.walletAddress || req.user.wallet) ? req.user.walletAddress || req.user.wallet : null;
}

function buildLimiter(max) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const wallet = getWalletAddress(req);
      return wallet ? `wallet:${wallet}` : `ip:${getClientIp(req)}`;
    },
    skip: (req) => isWhitelisted(req),
    store: new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: 'rl:',
    }),
    handler: (req, res) => {
      const resetTime = req.rateLimit && req.rateLimit.resetTime;
      const retryAfter = resetTime
        ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(WINDOW_MS / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please retry later.',
        retryAfter,
      });
    },
  });
}

const publicLimiter = buildLimiter(PUBLIC_LIMIT);
const authLimiter = buildLimiter(AUTH_LIMIT);

app.use((req, res, next) => {
  const limiter = getWalletAddress(req) ? authLimiter : publicLimiter;
  return limiter(req, res, next);
});

// --- Market search & filtering (issue #238) ---
// Full-text search over market question/description using PostgreSQL
// `tsvector` + GIN index, plus category and status filtering. The query is
// built with parameterized placeholders to avoid SQL injection.
const MARKET_CATEGORIES = ['crypto', 'sports', 'tech', 'politics'];
const MARKET_STATUSES = ['active', 'closed', 'resolved', 'pending'];

function buildMarketSearchQuery({ q, category, status, limit, offset }) {
  const conditions = [];
  const params = [];
  let orderBy = 'm.created_at DESC';

  if (q) {
    params.push(q);
    const rankParam = `$${params.length}`;
    conditions.push(`m.search_vector @@ websearch_to_tsquery('english', ${rankParam})`);
    orderBy = `ts_rank(m.search_vector, websearch_to_tsquery('english', ${rankParam})) DESC, m.created_at DESC`;
  }

  if (category) {
    params.push(category);
    conditions.push(`m.category = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`m.status = $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT m.*
    FROM markets m
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  return { sql, params };
}

function registerMarketSearchRoutes(db) {
  app.get('/api/markets', async (req, res, next) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : '';
      const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';

      if (category && !MARKET_CATEGORIES.includes(category)) {
        return res.status(400).json({
          error: 'Invalid category',
          message: `category must be one of: ${MARKET_CATEGORIES.join(', ')}`,
        });
      }

      if (status && !MARKET_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Invalid status',
          message: `status must be one of: ${MARKET_STATUSES.join(', ')}`,
        });
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const { sql, params } = buildMarketSearchQuery({
        q: q || null,
        category: category || null,
        status: status || null,
        limit,
        offset,
      });

      const result = await db.query(sql, params);
      return res.json({ markets: result.rows, limit, offset });
    } catch (err) {
      return next(err);
    }
  });
}

registerRouteSchema('/api/markets', 'get', {
  summary: 'Search and filter markets',
  tags: ['markets'],
  parameters: [
    { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search query' },
    { name: 'category', in: 'query', schema: { type: 'string', enum: MARKET_CATEGORIES } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: MARKET_STATUSES } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
  ],
  responses: {
    200: { description: 'Matching markets ordered by relevance' },
    400: { description: 'Invalid category or status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  },
});

app.registerRouteSchema = registerRouteSchema;
app.openApiSpec = openApiSpec;
app.registerMarketSearchRoutes = registerMarketSearchRoutes;
app.buildMarketSearchQuery = buildMarketSearchQuery;

module.exports = app;
