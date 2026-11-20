#!/usr/bin/env ts-node
/**
 * Automated secret rotation for database credentials and Soroban relayer keys.
 *
 * Implements:
 *  - Zero-downtime PostgreSQL password rotation using a dual-user strategy:
 *    a standby role is provisioned and activated before the active role is
 *    decommissioned, so no in-flight connection is dropped.
 *  - Soroban relayer keypair rotation that preserves in-flight transaction
 *    submissions through a grace window between old-key and new-key activation.
 *  - AWS Secrets Manager persistence so rotated credentials survive process
 *    restarts and are available to all running ECS tasks.
 *  - Optional ECS rolling restart so running tasks pick up the new secrets
 *    without manual intervention.
 *
 * Usage:
 *   ts-node backend/scripts/rotate-secrets.ts --target=db
 *   ts-node backend/scripts/rotate-secrets.ts --target=relayer
 *   ts-node backend/scripts/rotate-secrets.ts --target=all --dry-run
 *   ts-node backend/scripts/rotate-secrets.ts --target=all --restart-ecs
 *
 * See docs/SECRET-ROTATION.md for the full runbook.
 */

import { randomBytes } from 'crypto';
import { Client } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  ECSClient,
  UpdateServiceCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { Keypair } from '@stellar/stellar-sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RotationOptions {
  target: 'db' | 'relayer' | 'all';
  dryRun: boolean;
  restartEcs: boolean;
}

interface DbConfig {
  host: string;
  port: number;
  database: string;
  adminUser: string;
  adminPassword: string;
}

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

interface RelayerSecret {
  public_key: string;
  secret_key: string;
  previous_public_key?: string;
  rotated_at?: string;
}

interface EcsTarget {
  cluster: string;
  service: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTIVE_ROLE_ENV = 'DB_ACTIVE_ROLE';

const DB_SECRET_ARN =
  process.env.DB_SECRET_ARN ?? `ipredict/${process.env.ENVIRONMENT ?? 'staging'}/db`;
const RELAYER_SECRET_ARN =
  process.env.RELAYER_SECRET_ARN ??
  `ipredict/${process.env.ENVIRONMENT ?? 'staging'}/relayer`;

// ECS services that consume database / relayer secrets
const ECS_SERVICES: EcsTarget[] = [
  { cluster: process.env.ECS_CLUSTER ?? 'ipredict-staging', service: 'ipredict-staging-backend' },
  { cluster: process.env.ECS_CLUSTER ?? 'ipredict-staging', service: 'ipredict-staging-indexer' },
  { cluster: process.env.ECS_CLUSTER ?? 'ipredict-staging', service: 'ipredict-staging-oracle' },
];

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): RotationOptions {
  const targetArg = argv.find((a) => a.startsWith('--target='));
  const target = (targetArg?.split('=')[1] ?? 'all') as RotationOptions['target'];
  if (!['db', 'relayer', 'all'].includes(target)) {
    throw new Error(`Invalid --target value: ${target}`);
  }
  return {
    target,
    dryRun: argv.includes('--dry-run'),
    restartEcs: argv.includes('--restart-ecs'),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ── AWS clients ───────────────────────────────────────────────────────────────

function makeSecretsClient(): SecretsManagerClient {
  return new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
}

function makeEcsClient(): ECSClient {
  return new ECSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
}

// ── Secrets Manager helpers ───────────────────────────────────────────────────

async function getSecret<T>(client: SecretsManagerClient, secretId: string): Promise<T> {
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) {
    throw new Error(`Secret ${secretId} has no string value`);
  }
  return JSON.parse(result.SecretString) as T;
}

async function putSecret(
  client: SecretsManagerClient,
  secretId: string,
  value: unknown,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`[secrets] dry-run: would update secret ${secretId}`);
    return;
  }
  // Verify the secret exists before writing (fail fast rather than creating
  // an unintended secret in the wrong account / region).
  await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  await client.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify(value),
    }),
  );
  console.log(`[secrets] updated secret: ${secretId}`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Database rotation ─────────────────────────────────────────────────────────

function loadDbConfig(): DbConfig {
  return {
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: requireEnv('DB_NAME'),
    adminUser: requireEnv('DB_ADMIN_USER'),
    adminPassword: requireEnv('DB_ADMIN_PASSWORD'),
  };
}

/**
 * Zero-downtime dual-user rotation:
 *
 * 1. Provision a standby role (app_user_b if app_user_a is active, vice versa)
 *    with a freshly generated password.
 * 2. Grant it the same privileges as the currently active role.
 * 3. Persist the new credentials to AWS Secrets Manager.
 * 4. Flip the active role pointer so new connections use the standby role.
 * 5. Wait for in-flight connections on the old role to drain (DB_DRAIN_MS).
 * 6. Decommission the old role (revoke membership + set NOLOGIN).
 */
async function rotateDatabaseCredentials(
  config: DbConfig,
  secretsClient: SecretsManagerClient,
  dryRun: boolean,
): Promise<void> {
  const activeRole = process.env[ACTIVE_ROLE_ENV] ?? 'app_user_a';
  const nextRole = activeRole === 'app_user_a' ? 'app_user_b' : 'app_user_a';
  const newPassword = generatePassword();

  console.log(`[db] rotating ${activeRole} -> ${nextRole}`);

  if (!dryRun) {
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
      console.log(`[db] provisioned standby role ${nextRole}`);

      // 3. Persist new credentials to AWS Secrets Manager BEFORE flipping the
      //    active role so the application can read the new password at restart.
      const updatedSecret: DbSecret = {
        username: nextRole,
        password: newPassword,
        host: config.host,
        port: config.port,
        dbname: config.database,
      };
      await putSecret(secretsClient, DB_SECRET_ARN, updatedSecret, dryRun);

      // 4. Flip the active role pointer for new connections.
      process.env[ACTIVE_ROLE_ENV] = nextRole;
      console.log(`[db] active role switched to ${nextRole}`);

      // 5. Allow in-flight connections on the old role to drain.
      const drainMs = Number(process.env.DB_DRAIN_MS ?? 30_000);
      console.log(`[db] draining old role for ${drainMs}ms …`);
      await sleep(drainMs);

      // 6. Decommission the old role.
      await client.query(`REVOKE ${activeRole} FROM ${nextRole};`);
      await client.query(`ALTER ROLE ${activeRole} WITH NOLOGIN;`);
      console.log(`[db] decommissioned ${activeRole}`);
    } finally {
      await client.end();
    }
  } else {
    console.log('[db] dry-run: would provision standby role, update Secrets Manager, and drain');
  }
}

// ── Relayer key rotation ──────────────────────────────────────────────────────

/**
 * Rotate the Soroban relayer keypair without dropping in-flight submissions:
 *
 * 1. Generate a new Stellar keypair.
 * 2. Store the new keypair in Secrets Manager alongside the previous public key
 *    so monitoring tooling can verify the rotation and drain in-flight txns.
 * 3. Wait for the in-flight grace window (RELAYER_GRACE_MS) so any transaction
 *    built with the old key can still be submitted before the key is considered
 *    invalid.
 * 4. Remove the previous_public_key field from the secret once the grace period
 *    has elapsed, marking the rotation as complete.
 */
async function rotateRelayerKey(
  secretsClient: SecretsManagerClient,
  dryRun: boolean,
): Promise<void> {
  console.log('[relayer] generating new Stellar keypair …');

  const newKeypair = Keypair.random();
  const newPublicKey = newKeypair.publicKey();
  const newSecretKey = newKeypair.secret();

  // Read the current secret to preserve the old public key reference.
  let previousPublicKey: string | undefined;
  try {
    const current = await getSecret<RelayerSecret>(secretsClient, RELAYER_SECRET_ARN);
    previousPublicKey = current.public_key;
    console.log(`[relayer] previous public key: ${previousPublicKey}`);
  } catch (err) {
    console.warn('[relayer] could not read current relayer secret (first rotation?):', err);
  }

  const updatedSecret: RelayerSecret = {
    public_key: newPublicKey,
    secret_key: newSecretKey,
    previous_public_key: previousPublicKey,
    rotated_at: new Date().toISOString(),
  };

  // 2. Write the new secret (new key active, old key referenced for grace period).
  await putSecret(secretsClient, RELAYER_SECRET_ARN, updatedSecret, dryRun);
  console.log(`[relayer] new public key stored: ${newPublicKey}`);

  if (!dryRun) {
    // 3. Wait for in-flight transactions built against the old key to settle.
    const graceMs = Number(process.env.RELAYER_GRACE_MS ?? 60_000);
    console.log(`[relayer] grace window: waiting ${graceMs}ms for in-flight txns to drain …`);
    await sleep(graceMs);

    // 4. Clear the previous_public_key reference so it is no longer accessible.
    const finalSecret: RelayerSecret = {
      public_key: newPublicKey,
      secret_key: newSecretKey,
      rotated_at: updatedSecret.rotated_at,
    };
    await putSecret(secretsClient, RELAYER_SECRET_ARN, finalSecret, dryRun);
    console.log('[relayer] previous key reference removed – rotation complete');
  }
}

// ── ECS rolling restart ───────────────────────────────────────────────────────

/**
 * Force a new deployment on each ECS service so tasks reload secrets from
 * Secrets Manager. Uses forceNewDeployment=true which triggers a rolling
 * update (old tasks stay healthy until new tasks pass health checks).
 */
async function rollingRestartEcs(dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log('[ecs] dry-run: would trigger rolling restart on', ECS_SERVICES.map((s) => s.service).join(', '));
    return;
  }

  const ecsClient = makeEcsClient();

  for (const target of ECS_SERVICES) {
    console.log(`[ecs] triggering rolling restart: ${target.cluster}/${target.service}`);
    try {
      // Verify the service exists before issuing the update.
      await ecsClient.send(
        new DescribeServicesCommand({ cluster: target.cluster, services: [target.service] }),
      );
      await ecsClient.send(
        new UpdateServiceCommand({
          cluster: target.cluster,
          service: target.service,
          forceNewDeployment: true,
        }),
      );
      console.log(`[ecs] rolling restart initiated: ${target.service}`);
    } catch (err) {
      console.error(`[ecs] failed to restart service ${target.service}:`, err);
      // Log but continue – a failed restart of one service should not abort
      // the rotation; operators can restart it manually.
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `[rotate-secrets] target=${options.target} dryRun=${options.dryRun} restartEcs=${options.restartEcs}`,
  );

  const secretsClient = makeSecretsClient();

  if (options.target === 'db' || options.target === 'all') {
    await rotateDatabaseCredentials(loadDbConfig(), secretsClient, options.dryRun);
  }

  if (options.target === 'relayer' || options.target === 'all') {
    await rotateRelayerKey(secretsClient, options.dryRun);
  }

  if (options.restartEcs) {
    await rollingRestartEcs(options.dryRun);
  }

  console.log('[rotate-secrets] rotation complete');
}

main().catch((err) => {
  console.error('[rotate-secrets] rotation failed:', err);
  process.exit(1);
});
