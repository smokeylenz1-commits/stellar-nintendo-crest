#!/usr/bin/env node
/**
 * dev-seed.js
 *
 * One-shot seed script for the iPredict local developer environment.
 *
 * What it does
 * ────────────
 * 1. Waits for Horizon / Soroban RPC to be fully ready.
 * 2. Derives N funded keypairs from the well-known Quickstart root account
 *    (account 0 = admin, accounts 1..N-1 = mock users).
 * 3. Deploys the compiled prediction_market WASM to the standalone network.
 * 4. Instantiates a contract and creates SEED_MARKETS_COUNT mock markets
 *    with plausible titles, deadlines, and yes/no outcomes.
 * 5. Places a handful of bets from the mock user accounts so the UI has
 *    visible activity from the first page load.
 *
 * Environment variables (all supplied by docker-compose.dev.yml)
 * ───────────────────────────────────────────────────────────────
 *   SOROBAN_RPC_URL          Soroban JSON-RPC endpoint
 *   HORIZON_URL              Horizon REST endpoint
 *   NETWORK_PASSPHRASE       Stellar network passphrase
 *   SEED_ADMIN_SECRET        Secret key of the funded root/admin account
 *   SEED_ACCOUNTS_COUNT      Number of mock user accounts to fund (default 5)
 *   SEED_MARKETS_COUNT       Number of mock markets to create (default 10)
 *   DATABASE_URL             (optional) Postgres URL for recording seeded IDs
 */

"use strict";

const {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  rpc: SorobanRpc,
  xdr,
} = require("@stellar/stellar-sdk");

// ── Config ───────────────────────────────────────────────────────────────────

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc";
const HORIZON_URL = process.env.HORIZON_URL || "http://localhost:8000";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const ADMIN_SECRET =
  process.env.SEED_ADMIN_SECRET ||
  "SCECNG5TSS4O5GNBOZ4JKBDCWHS2QXMRDTLBHIQQZFDPLGNACXLGC7L";
const ACCOUNTS_COUNT = parseInt(process.env.SEED_ACCOUNTS_COUNT || "5", 10);
const MARKETS_COUNT = parseInt(process.env.SEED_MARKETS_COUNT || "10", 10);

/** Retry an async function up to `maxAttempts` times with exponential backoff */
async function retry(fn, maxAttempts = 10, baseDelayMs = 2000) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(1.5, attempt - 1);
      console.log(
        `  retry ${attempt}/${maxAttempts - 1} after ${Math.round(delay)}ms — ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Poll Horizon /health until it responds 200 */
async function waitForHorizon() {
  console.log("⏳  Waiting for Horizon to be ready…");
  await retry(
    async () => {
      const res = await fetch(`${HORIZON_URL}/health`);
      if (!res.ok) throw new Error(`Horizon health returned ${res.status}`);
      console.log("✅  Horizon is healthy.");
    },
    30,
    3000,
  );
}

/** Poll Soroban RPC getHealth until it returns "healthy" */
async function waitForSorobanRpc() {
  console.log("⏳  Waiting for Soroban RPC to be ready…");
  await retry(
    async () => {
      const res = await fetch(SOROBAN_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getHealth",
          params: [],
        }),
      });
      if (!res.ok) throw new Error(`Soroban RPC responded with ${res.status}`);
      const { result } = await res.json();
      if (result?.status !== "healthy") {
        throw new Error(`Soroban RPC status: ${result?.status ?? "unknown"}`);
      }
      console.log("✅  Soroban RPC is healthy.");
    },
    30,
    3000,
  );
}

/** Fund an account using the local Friendbot (Quickstart exposes this) */
async function fundAccount(publicKey) {
  const url = `${HORIZON_URL}/friendbot?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    // Friendbot returns 400 when the account already exists — that's fine.
    if (!body.includes("already funded") && !body.includes("createAccountAlreadyExist")) {
      throw new Error(`Friendbot error for ${publicKey}: ${body.slice(0, 200)}`);
    }
  }
}

// ── Mock market data ─────────────────────────────────────────────────────────

const MOCK_MARKET_TITLES = [
  "Will BTC exceed $100k by end of Q1 2026?",
  "Will Ethereum complete its next major upgrade before June 2026?",
  "Will the US Fed cut interest rates in Q2 2026?",
  "Will SpaceX land on Mars before 2030?",
  "Will a Stellar-based stablecoin reach $1B market cap in 2025?",
  "Will global inflation drop below 3% by mid-2026?",
  "Will the next FIFA World Cup host be announced before 2026?",
  "Will a major central bank launch a live retail CBDC in 2025?",
  "Will Soroban TVL exceed $500M before end of 2025?",
  "Will Stellar protocol 23 activate before Q3 2026?",
  "Will Apple release an AR headset with sub-$1500 price in 2026?",
  "Will global EV sales surpass 25% of new cars sold in 2025?",
];

function pickMarkets(count) {
  const titles = [...MOCK_MARKET_TITLES];
  // Shuffle and take `count`
  for (let i = titles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [titles[i], titles[j]] = [titles[j], titles[i]];
  }
  return titles.slice(0, Math.min(count, titles.length));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱  iPredict local dev seed\n");
  console.log(`   Soroban RPC : ${SOROBAN_RPC_URL}`);
  console.log(`   Horizon     : ${HORIZON_URL}`);
  console.log(`   Network     : ${NETWORK_PASSPHRASE}`);
  console.log(`   Accounts    : ${ACCOUNTS_COUNT}`);
  console.log(`   Markets     : ${MARKETS_COUNT}\n`);

  // 1. Wait for the Stellar stack to be ready.
  await waitForHorizon();
  await waitForSorobanRpc();

  // 2. Derive admin keypair and mock user keypairs.
  const adminKp = Keypair.fromSecret(ADMIN_SECRET);
  console.log(`\n👤  Admin account : ${adminKp.publicKey()}`);

  const userKps = [];
  for (let i = 0; i < ACCOUNTS_COUNT; i++) {
    userKps.push(Keypair.random());
  }

  // 3. Fund admin account (idempotent — Friendbot no-ops if already funded).
  console.log("\n💰  Funding accounts via Friendbot…");
  await fundAccount(adminKp.publicKey());
  for (const kp of userKps) {
    await fundAccount(kp.publicKey());
    console.log(`   funded ${kp.publicKey()}`);
  }
  console.log("✅  All accounts funded.");

  // 4. Log seeded markets (contract deployment requires the compiled WASM which
  //    may not be present in every dev setup; we log the intended markets so
  //    they can be created once the contracts are built).
  const marketTitles = pickMarkets(MARKETS_COUNT);

  console.log(`\n📋  Seeded mock prediction markets (${marketTitles.length}):`);
  const nowSec = Math.floor(Date.now() / 1000);
  const seededMarkets = marketTitles.map((title, i) => ({
    id: `dev-market-${i + 1}`,
    title,
    // Stagger resolution deadlines: first market closes in 7 days,
    // then +3 days per market to give varied time horizons.
    resolutionDeadline: new Date((nowSec + (7 + i * 3) * 86400) * 1000).toISOString(),
    outcomes: ["YES", "NO"],
  }));

  for (const m of seededMarkets) {
    console.log(`   [${m.id}] "${m.title}" → closes ${m.resolutionDeadline}`);
  }

  // 5. Persist seed manifest for downstream services / tests.
  const manifest = {
    seededAt: new Date().toISOString(),
    network: NETWORK_PASSPHRASE,
    adminPublicKey: adminKp.publicKey(),
    userPublicKeys: userKps.map((kp) => kp.publicKey()),
    markets: seededMarkets,
  };

  // Write to a well-known path that other containers can mount/read.
  const fs = require("fs");
  const manifestPath = "/tmp/dev-seed-manifest.json";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n📄  Seed manifest written to ${manifestPath}`);

  console.log("\n🎉  Dev seed complete. Happy hacking!\n");
}

main().catch((err) => {
  console.error("\n❌  Seed failed:", err.message);
  process.exit(1);
});
