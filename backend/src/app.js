const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

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

// --- Dispute evidence IPFS archive storage (issue #231) ---
// Accepts PNG, JPG, or PDF evidence up to 10MB, pins it to IPFS via Pinata,
// and returns the resulting CID so it can be saved with the dispute record.
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const EVIDENCE_ALLOWED_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['application/pdf', 'pdf'],
]);

// Raw body parser scoped to the evidence route so the global JSON parser is untouched.
app.post(
  '/api/disputes/evidence',
  express.raw({ type: () => true, limit: EVIDENCE_MAX_BYTES }),
  async (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extension = EVIDENCE_ALLOWED_TYPES.get(contentType);

    if (!extension) {
      return res.status(415).json({
        error: 'Unsupported evidence file type. Allowed types: PNG, JPG, PDF.',
      });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'Evidence file is empty or missing.' });
    }

    if (body.length > EVIDENCE_MAX_BYTES) {
      return res.status(413).json({ error: 'Evidence file exceeds the 10MB limit.' });
    }

    const pinataJwt = process.env.PINATA_JWT;
    if (!pinataJwt) {
      return res.status(503).json({ error: 'IPFS pinning service is not configured.' });
    }

    try {
      const form = new FormData();
      form.append('file', new Blob([body], { type: contentType }), `evidence.${extension}`);
      form.append('pinataMetadata', JSON.stringify({ name: `dispute-evidence-${Date.now()}.${extension}` }));

      const pinataResponse = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwt}` },
        body: form,
      });

      if (!pinataResponse.ok) {
        return res.status(502).json({ error: 'Failed to pin evidence to IPFS.' });
      }

      const { IpfsHash } = await pinataResponse.json();
      if (!IpfsHash) {
        return res.status(502).json({ error: 'IPFS pinning service returned no CID.' });
      }

      return res.status(201).json({
        cid: IpfsHash,
        contentType,
        size: body.length,
        gatewayUrl: `https://gateway.pinata.cloud/ipfs/${IpfsHash}`,
      });
    } catch (err) {
      return res.status(502).json({ error: 'Failed to pin evidence to IPFS.' });
    }
  }
);

module.exports = app;
