const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://app.example.com,https://www.example.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Whitelist for referral display names: alphanumeric plus underscore/hyphen, 3-20 chars.
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

// Common Unicode confusables (Cyrillic/Greek/fullwidth lookalikes) mapped to ASCII.
const HOMOGLYPH_MAP = {
  // Cyrillic
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
  '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0425': 'X', '\u0423': 'Y', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  // Greek
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03BF': 'o',
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v',
  '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x',
};

/**
 * Normalize Unicode confusables to their ASCII equivalents so lookalike
 * characters cannot be used to impersonate other users.
 */
function normalizeHomoglyphs(value) {
  return value.replace(/[\u0080-\uFFFF]/g, (char) => HOMOGLYPH_MAP[char] || char);
}

/**
 * Sanitize a referral display name.
 * Strips HTML/script content, normalizes homoglyphs, then enforces the
 * alphanumeric whitelist and 3-20 character length constraint.
 * Returns the sanitized name, or null when the input is invalid.
 */
function sanitizeDisplayName(rawName) {
  if (typeof rawName !== 'string') {
    return null;
  }

  // Remove any HTML tags and angle brackets to neutralize XSS vectors.
  const withoutTags = rawName.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  const normalized = normalizeHomoglyphs(withoutTags).trim();

  if (!DISPLAY_NAME_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

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

app.sanitizeDisplayName = sanitizeDisplayName;
app.normalizeHomoglyphs = normalizeHomoglyphs;

module.exports = app;
