const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://app.example.com,https://www.example.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Whitelist for referral display names: alphanumerics, underscore and hyphen only.
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

// Common Unicode confusables mapped to their ASCII lookalikes so that
// homoglyph impersonation attempts are normalized before validation.
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
  '\u03C1': 'p', '\u03C5': 'u', '\u03C7': 'x',
  // Fullwidth Latin
  '\uFF21': 'A', '\uFF22': 'B', '\uFF23': 'C', '\uFF24': 'D', '\uFF25': 'E',
  '\uFF26': 'F', '\uFF27': 'G', '\uFF28': 'H', '\uFF29': 'I', '\uFF2A': 'J',
  '\uFF2B': 'K', '\uFF2C': 'L', '\uFF2D': 'M', '\uFF2E': 'N', '\uFF2F': 'O',
  '\uFF30': 'P', '\uFF31': 'Q', '\uFF32': 'R', '\uFF33': 'S', '\uFF34': 'T',
  '\uFF35': 'U', '\uFF36': 'V', '\uFF37': 'W', '\uFF38': 'X', '\uFF39': 'Y',
  '\uFF3A': 'Z',
  '\uFF41': 'a', '\uFF42': 'b', '\uFF43': 'c', '\uFF44': 'd', '\uFF45': 'e',
  '\uFF46': 'f', '\uFF47': 'g', '\uFF48': 'h', '\uFF49': 'i', '\uFF4A': 'j',
  '\uFF4B': 'k', '\uFF4C': 'l', '\uFF4D': 'm', '\uFF4E': 'n', '\uFF4F': 'o',
  '\uFF50': 'p', '\uFF51': 'q', '\uFF52': 'r', '\uFF53': 's', '\uFF54': 't',
  '\uFF55': 'u', '\uFF56': 'v', '\uFF57': 'w', '\uFF58': 'x', '\uFF59': 'y',
  '\uFF5A': 'z',
};

/**
 * Normalize Unicode confusable characters to their ASCII equivalents.
 * @param {string} value
 * @returns {string}
 */
function normalizeHomoglyphs(value) {
  return value.replace(/[\u0080-\uFFFF]/g, (char) => HOMOGLYPH_MAP[char] || char);
}

/**
 * Sanitize a referral display name against XSS and homoglyph impersonation.
 * Strips HTML/script content, normalizes confusables, then enforces the
 * `^[a-zA-Z0-9_-]{3,20}$` whitelist and length constraint.
 * @param {string} name
 * @returns {string|null} sanitized name, or null when invalid
 */
function sanitizeDisplayName(name) {
  if (typeof name !== 'string') {
    return null;
  }

  // Remove any HTML tags and script content before further processing.
  const stripped = name
    .replace(/<[^>]*>/g, '')
    .replace(/[<>"'`]/g, '')
    .trim();

  const normalized = normalizeHomoglyphs(stripped);

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

app.sanitizeDisplayName = sanitizeDisplayName;
app.normalizeHomoglyphs = normalizeHomoglyphs;

module.exports = app;
