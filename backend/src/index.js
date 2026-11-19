const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const { Keypair, TransactionBuilder, Networks, Account, Operation, BASE_FEE, Transaction } = require('@stellar/stellar-sdk');

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

// --- SEP-10 wallet authentication -----------------------------------------

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
const SERVER_SIGNING_SECRET = process.env.SEP10_SERVER_SIGNING_SECRET || null;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 900);
const CHALLENGE_TTL_SECONDS = Number(process.env.SEP10_CHALLENGE_TTL_SECONDS || 300);
const HOME_DOMAIN = process.env.SEP10_HOME_DOMAIN || 'localhost';
const WEB_AUTH_DOMAIN = process.env.SEP10_WEB_AUTH_DOMAIN || HOME_DOMAIN;
const CLIENT_DOMAIN = process.env.SEP10_CLIENT_DOMAIN || null;

// In-memory challenge store keyed by the challenge transaction hash.
const pendingChallenges = new Map();

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

function issueTokens(account) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwt({ sub: account, iat: now, exp: now + JWT_TTL_SECONDS, iss: HOME_DOMAIN });
  const refreshToken = signJwt({ sub: account, iat: now, exp: now + JWT_TTL_SECONDS * 8, typ: 'refresh', iss: HOME_DOMAIN });
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: JWT_TTL_SECONDS };
}

function buildChallenge(account) {
  const serverKeypair = SERVER_SIGNING_SECRET
    ? Keypair.fromSecret(SERVER_SIGNING_SECRET)
    : Keypair.random();
  const now = Math.floor(Date.now() / 1000);
  const transaction = new TransactionBuilder(new Account(account, '-1'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: { minTime: now, maxTime: now + CHALLENGE_TTL_SECONDS },
  })
    .addOperation(
      Operation.manageData({
        name: `${WEB_AUTH_DOMAIN} auth`,
        value: crypto.randomBytes(48).toString('base64'),
      })
    )
    .addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: WEB_AUTH_DOMAIN,
      })
    );
  if (CLIENT_DOMAIN) {
    transaction.addOperation(
      Operation.manageData({
        name: 'client_domain',
        value: CLIENT_DOMAIN,
      })
    );
  }
  const built = transaction.setTimeout(0).build();
  built.sign(serverKeypair);
  return built;
}

app.post('/api/auth/challenge', (req, res) => {
  const { account } = req.body || {};
  if (!account || typeof account !== 'string') {
    return res.status(400).json({ error: 'account is required' });
  }
  try {
    Keypair.fromPublicKey(account);
  } catch (err) {
    return res.status(400).json({ error: 'invalid Stellar account' });
  }

  const challenge = buildChallenge(account);
  const xdr = challenge.toXDR();
  const hash = challenge.hash().toString('hex');
  pendingChallenges.set(hash, { account, createdAt: Date.now() });

  return res.json({
    transaction: xdr,
    network_passphrase: NETWORK_PASSPHRASE,
  });
});

app.post('/api/auth/verify', (req, res) => {
  const { transaction } = req.body || {};
  if (!transaction || typeof transaction !== 'string') {
    return res.status(400).json({ error: 'transaction is required' });
  }

  let parsed;
  try {
    parsed = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
  } catch (err) {
    return res.status(400).json({ error: 'invalid challenge transaction' });
  }

  if (!(parsed instanceof Transaction)) {
    return res.status(400).json({ error: 'invalid challenge transaction' });
  }

  const hash = parsed.hash().toString('hex');
  const pending = pendingChallenges.get(hash);
  if (!pending) {
    return res.status(400).json({ error: 'unknown or expired challenge' });
  }
  pendingChallenges.delete(hash);

  const now = Math.floor(Date.now() / 1000);
  const timebounds = parsed.timeBounds;
  if (!timebounds || now < Number(timebounds.minTime) || now > Number(timebounds.maxTime)) {
    return res.status(400).json({ error: 'challenge expired' });
  }

  const operations = parsed.operations;
  if (!operations.length || operations[0].type !== 'manageData' || operations[0].name !== `${WEB_AUTH_DOMAIN} auth`) {
    return res.status(400).json({ error: 'invalid challenge operation' });
  }

  const clientDomainOp = operations.find((op) => op.type === 'manageData' && op.name === 'client_domain');
  if (CLIENT_DOMAIN && (!clientDomainOp || clientDomainOp.value.toString() !== CLIENT_DOMAIN)) {
    return res.status(400).json({ error: 'invalid client domain' });
  }

  const account = pending.account;
  const signatures = parsed.signatures || [];
  const clientSigned = signatures.some((sig) => {
    try {
      return Keypair.fromPublicKey(account).verify(parsed.hash(), sig.signature());
    } catch (err) {
      return false;
    }
  });

  if (!clientSigned) {
    return res.status(401).json({ error: 'missing or invalid wallet signature' });
  }

  return res.json(issueTokens(account));
});

app.post('/api/auth/refresh', (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  const payload = verifyJwt(refreshToken);
  if (!payload || payload.typ !== 'refresh') {
    return res.status(401).json({ error: 'invalid refresh token' });
  }
  return res.json(issueTokens(payload.sub));
});

module.exports = app;
