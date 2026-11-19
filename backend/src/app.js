const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const { Keypair, Networks, TransactionBuilder, Transaction, Operation, Account, BASE_FEE } = require('@stellar/stellar-sdk');

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

// --- SEP-10 wallet authentication -----------------------------------------

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
const SERVER_SIGNING_SECRET = process.env.STELLAR_SERVER_SIGNING_SECRET || null;
const HOME_DOMAIN = process.env.SEP10_HOME_DOMAIN || 'localhost';
const WEB_AUTH_DOMAIN = process.env.SEP10_WEB_AUTH_DOMAIN || HOME_DOMAIN;
const CHALLENGE_TTL_SECONDS = 300;
const JWT_SECRET = process.env.JWT_SECRET || null;
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 900);
const JWT_REFRESH_TTL_SECONDS = Number(process.env.JWT_REFRESH_TTL_SECONDS || 86400);

// In-memory stores for issued challenges and refresh tokens. Replace with a
// persistent store in production deployments.
const pendingChallenges = new Map();
const refreshTokens = new Map();

function getServerKeypair() {
  if (SERVER_SIGNING_SECRET) {
    return Keypair.fromSecret(SERVER_SIGNING_SECRET);
  }
  // Ephemeral keypair so the flow works out of the box in development.
  return Keypair.random();
}

const serverKeypair = getServerKeypair();

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload, ttlSeconds) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

function verifyJwt(token) {
  if (!JWT_SECRET || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [encodedHeader, encodedBody, signature] = parts;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedBody, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function issueTokens(account) {
  const accessToken = signJwt({ sub: account, type: 'access' }, JWT_TTL_SECONDS);
  const refreshToken = crypto.randomBytes(32).toString('hex');
  refreshTokens.set(refreshToken, {
    account,
    expiresAt: Date.now() + JWT_REFRESH_TTL_SECONDS * 1000,
  });
  return {
    token: accessToken,
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: JWT_TTL_SECONDS,
  };
}

function isValidAccount(account) {
  try {
    Keypair.fromPublicKey(account);
    return true;
  } catch (err) {
    return false;
  }
}

app.post('/api/auth/challenge', (req, res) => {
  const { account, clientDomain } = req.body || {};
  if (!account || !isValidAccount(account)) {
    return res.status(400).json({ error: 'A valid Stellar account is required' });
  }

  const now = Math.floor(Date.now() / 1000);
  const challengeAccount = new Account(serverKeypair.publicKey(), '-1');
  const builder = new TransactionBuilder(challengeAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: { minTime: now, maxTime: now + CHALLENGE_TTL_SECONDS },
  });

  builder.addOperation(
    Operation.manageData({
      name: `${WEB_AUTH_DOMAIN} auth`,
      value: crypto.randomBytes(48).toString('base64'),
    })
  );
  builder.addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH_DOMAIN }));
  if (clientDomain) {
    builder.addOperation(Operation.manageData({ name: 'client_domain', value: String(clientDomain) }));
  }

  const transaction = builder.setTimeout(0).build();
  transaction.sign(serverKeypair);

  const xdr = transaction.toEnvelope().toXDR('base64');
  pendingChallenges.set(account, {
    xdr,
    createdAt: Date.now(),
    expiresAt: (now + CHALLENGE_TTL_SECONDS) * 1000,
  });

  return res.json({
    transaction: xdr,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
});

app.post('/api/auth/verify', (req, res) => {
  const { transaction: signedXdr } = req.body || {};
  if (!signedXdr || typeof signedXdr !== 'string') {
    return res.status(400).json({ error: 'Signed challenge transaction is required' });
  }

  let transaction;
  try {
    transaction = new Transaction(signedXdr, NETWORK_PASSPHRASE);
  } catch (err) {
    return res.status(400).json({ error: 'Malformed challenge transaction' });
  }

  const now = Math.floor(Date.now() / 1000);
  const timebounds = transaction.timeBounds;
  if (!timebounds || now < Number(timebounds.minTime) || now > Number(timebounds.maxTime)) {
    return res.status(400).json({ error: 'Challenge transaction is expired or not yet valid' });
  }

  if (transaction.source !== serverKeypair.publicKey()) {
    return res.status(400).json({ error: 'Challenge transaction source mismatch' });
  }

  const operations = transaction.operations;
  const manageDataOps = operations.filter((op) => op.type === 'manageData');
  const authOp = manageDataOps.find((op) => op.name === `${WEB_AUTH_DOMAIN} auth`);
  if (!authOp) {
    return res.status(400).json({ error: 'Missing SEP-10 auth operation' });
  }

  const clientAccount = authOp.source;
  if (!clientAccount || !isValidAccount(clientAccount)) {
    return res.status(400).json({ error: 'Challenge is not bound to a valid client account' });
  }

  const pending = pendingChallenges.get(clientAccount);
  if (!pending || pending.xdr !== signedXdr || pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Unknown or expired challenge' });
  }

  const serverSigned = transaction.signatures.some((sig) => {
    try {
      return serverKeypair.verify(transaction.hash(), sig.signature());
    } catch (err) {
      return false;
    }
  });
  if (!serverSigned) {
    return res.status(400).json({ error: 'Challenge is not signed by the server' });
  }

  const clientKeypair = Keypair.fromPublicKey(clientAccount);
  const clientSigned = transaction.signatures.some((sig) => {
    try {
      return clientKeypair.verify(transaction.hash(), sig.signature());
    } catch (err) {
      return false;
    }
  });
  if (!clientSigned) {
    return res.status(401).json({ error: 'Challenge is not signed by the client account' });
  }

  pendingChallenges.delete(clientAccount);

  return res.json(issueTokens(clientAccount));
});

app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'Refresh token is required' });
  }
  const record = refreshTokens.get(refreshToken);
  if (!record || record.expiresAt < Date.now()) {
    refreshTokens.delete(refreshToken);
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
  refreshTokens.delete(refreshToken);
  return res.json(issueTokens(record.account));
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const payload = verifyJwt(token);
  if (!payload || payload.type !== 'access') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.auth = { account: payload.sub };
  return next();
}

app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({ account: req.auth.account });
});

module.exports = app;
module.exports.requireAuth = requireAuth;
