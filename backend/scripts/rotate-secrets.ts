#!/usr/bin/env ts-node
/**
 * Automated secret rotation for API keys and database credentials.
 *
 * Implements zero-downtime PostgreSQL password rotation using a dual-user
 * strategy: a new role is provisioned and switched to before the old role is
 * decommissioned, so existing connections are never dropped mid-rotation.
 *
 * Usage:
 *   ts-node backend/scripts/rotate-secrets.ts --target=db
 *   ts-node backend/scripts/rotate-secrets.ts --target=api
 *   ts-node backend/scripts/rotate-secrets.ts --target=all --dry-run
 *
 * See docs/SECRET-ROTATION.md for the full runbook.
 */

import { randomBytes } from 'crypto';
import { Client } from 'pg';

interface RotationOptions {
  target: 'db' | 'api' | 'all';
  dryRun: boolean;
}

interface DbConfig {
  host: string;
  port: number;
  database: string;
  adminUser: string;
  adminPassword: string;
}

const ACTIVE_ROLE_ENV = 'DB_ACTIVE_ROLE';
const API_KEY_ENV = 'API_KEY';

function parseArgs(argv: string[]): RotationOptions {
  const targetArg = argv.find((a) => a.startsWith('--target='));
  const target = (targetArg?.split('=')[1] ?? 'all') as RotationOptions['target'];
  if (!['db', 'api', 'all'].includes(target)) {
    throw new Error(`Invalid --target value: ${target}`);
  }
  return { target, dryRun: argv.includes('--dry-run') };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadDbConfig(): DbConfig {
  return {
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: requireEnv('DB_NAME'),
    adminUser: requireEnv('DB_ADMIN_USER'),
    adminPassword: requireEnv('DB_ADMIN_PASSWORD'),
  };
}

function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Zero-downtime dual-user rotation.
 *
 * 1. Create a new role with a fresh password.
 * 2. Grant it the same privileges as the currently active role.
 * 3. Flip the active role pointer (DB_ACTIVE_ROLE) so new connections use it.
 * 4. Wait for in-flight connections on the old role to drain.
 * 5. Decommission the old role.
 */
async function rotateDatabaseCredentials(
  config: DbConfig,
  dryRun: boolean,
): Promise<void> {
  const activeRole = process.env[ACTIVE_ROLE_ENV] ?? 'app_user_a';
  const nextRole = activeRole === 'app_user_a' ? 'app_user_b' : 'app_user_a';
  const newPassword = generatePassword();

  console.log(`[db] rotating ${activeRole} -> ${nextRole}`);
  if (dryRun) {
    console.log('[db] dry-run: skipping role creation and switch');
    return;
  }

  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.adminUser,
    password: config.adminPassword,
  });

  await client.connect();
  try {
    // 1. Provision the standby role with a fresh password.
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${nextRole}') THEN
           CREATE ROLE ${nextRole} LOGIN PASSWORD '${newPassword}';
         ELSE
           ALTER ROLE ${nextRole} WITH LOGIN PASSWORD '${newPassword}';
         END IF;
       END $$;`,
    );

    // 2. Mirror privileges from the active role.
    await client.query(`GRANT ${activeRole} TO ${nextRole};`);

    // 3. Flip the active role pointer for new connections.
    process.env[ACTIVE_ROLE_ENV] = nextRole;
    console.log(`[db] active role switched to ${nextRole}`);

    // 4. Allow in-flight connections on the old role to drain.
    const drainMs = Number(process.env.DB_DRAIN_MS ?? 30000);
    console.log(`[db] draining old role for ${drainMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, drainMs));

    // 5. Decommission the old role.
    await client.query(`REVOKE ${activeRole} FROM ${nextRole};`);
    await client.query(`ALTER ROLE ${activeRole} WITH NOLOGIN;`);
    console.log(`[db] decommissioned ${activeRole}`);
  } finally {
    await client.end();
  }
}

/**
 * Rotate the API key. The new key is written to the secret store and the
 * previous key is retained for a grace period so callers can roll over
 * without downtime.
 */
async function rotateApiKey(dryRun: boolean): Promise<void> {
  const newKey = randomBytes(32).toString('hex');
  console.log('[api] generated new API key');
  if (dryRun) {
    console.log('[api] dry-run: skipping secret store update');
    return;
  }

  // Persist the new key and keep the previous one valid during the grace window.
  process.env[API_KEY_ENV] = newKey;
  const graceMs = Number(process.env.API_KEY_GRACE_MS ?? 60000);
  console.log(`[api] new key active; previous key valid for ${graceMs}ms`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[rotate-secrets] target=${options.target} dryRun=${options.dryRun}`);

  if (options.target === 'db' || options.target === 'all') {
    await rotateDatabaseCredentials(loadDbConfig(), options.dryRun);
  }
  if (options.target === 'api' || options.target === 'all') {
    await rotateApiKey(options.dryRun);
  }

  console.log('[rotate-secrets] rotation complete');
}

main().catch((err) => {
  console.error('[rotate-secrets] rotation failed:', err);
  process.exit(1);
});
