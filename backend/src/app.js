const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

const ORACLE_HMAC_SECRET = process.env.ORACLE_HMAC_SECRET || '';
const ORACLE_TIMESTAMP_TOLERANCE_SECONDS = 300;

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Oracle-Signature', 'X-Oracle-Timestamp'],
    credentials: true,
    maxAge: 86400,
  })
);

app.use(express.json());

function computeOracleSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyOracleSignature(req, res, next) {
  const signatureHeader = req.get('X-Oracle-Signature');
  const timestampHeader = req.get('X-Oracle-Timestamp');

  if (!signatureHeader || !timestampHeader) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > ORACLE_TIMESTAMP_TOLERANCE_SECONDS) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ORACLE_HMAC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawBody = req.rawBody !== undefined ? req.rawBody : JSON.stringify(req.body || {});
  const expected = computeOracleSignature(ORACLE_HMAC_SECRET, timestampHeader, rawBody);

  if (!safeCompare(expected, match[1].toLowerCase())) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

app.verifyOracleSignature = verifyOracleSignature;
app.computeOracleSignature = computeOracleSignature;

module.exports = app;
