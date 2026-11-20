# Secret Rotation Runbook

This runbook documents how to rotate database credentials and Soroban relayer
keypairs using `backend/scripts/rotate-secrets.ts`. The procedure is designed
for **zero-downtime** rotation and stores all credentials in AWS Secrets Manager.

## Prerequisites

- Node.js and `ts-node` available in the backend environment.
- Admin database credentials exported as environment variables:
  - `DB_HOST`, `DB_PORT`, `DB_NAME`
  - `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD`
- AWS credentials with permissions to `secretsmanager:GetSecretValue`,
  `secretsmanager:PutSecretValue`, and `secretsmanager:DescribeSecret` on:
  - `ipredict/<env>/db`
  - `ipredict/<env>/relayer`
- The ARNs / names of those secrets in environment variables (optional –
  defaults derived from `ENVIRONMENT`):
  - `DB_SECRET_ARN`
  - `RELAYER_SECRET_ARN`
- For ECS rolling restarts: `ecs:UpdateService` and `ecs:DescribeServices`
  on the iPredict cluster, and `ECS_CLUSTER` env var set to the cluster name.

## Zero-Downtime Database Rotation (Dual-User)

The dual-user strategy ensures no connection is dropped mid-rotation:

1. **Provision** a standby role (`app_user_a` ↔ `app_user_b`) with a freshly
   generated password.
2. **Grant** the standby role the same privileges as the active role.
3. **Persist** the new credentials to AWS Secrets Manager so running tasks can
   read them after a restart.
4. **Switch** the active role pointer (`DB_ACTIVE_ROLE`) so new connections use
   the standby role.
5. **Drain** in-flight connections on the old role for `DB_DRAIN_MS`
   (default `30000` ms).
6. **Decommission** the old role (revoke membership + set `NOLOGIN`).

### Run

```bash
# Preview without making changes
ts-node backend/scripts/rotate-secrets.ts --target=db --dry-run

# Execute the rotation
ts-node backend/scripts/rotate-secrets.ts --target=db

# Rotate and immediately trigger an ECS rolling restart
ts-node backend/scripts/rotate-secrets.ts --target=db --restart-ecs
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | – | PostgreSQL host (required) |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | – | Database name (required) |
| `DB_ADMIN_USER` | – | Admin role with CREATE ROLE privileges (required) |
| `DB_ADMIN_PASSWORD` | – | Admin password (required) |
| `DB_ACTIVE_ROLE` | `app_user_a` | Currently active application role |
| `DB_DRAIN_MS` | `30000` | Milliseconds to wait for old-role connections to drain |
| `DB_SECRET_ARN` | `ipredict/<env>/db` | AWS Secrets Manager secret ID/ARN |

## Soroban Relayer Key Rotation

The relayer keypair rotation preserves in-flight transaction submissions:

1. **Generate** a new Stellar keypair (`Keypair.random()`).
2. **Write** to Secrets Manager with both the new key and a `previous_public_key`
   reference so monitoring tools can confirm the rotation.
3. **Wait** for the grace window (`RELAYER_GRACE_MS`, default `60000` ms) for
   any transaction built with the old key to settle on-chain.
4. **Remove** the `previous_public_key` field, completing the rotation.

### Run

```bash
# Preview without making changes
ts-node backend/scripts/rotate-secrets.ts --target=relayer --dry-run

# Execute the rotation
ts-node backend/scripts/rotate-secrets.ts --target=relayer

# Rotate and trigger ECS rolling restart
ts-node backend/scripts/rotate-secrets.ts --target=relayer --restart-ecs
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `RELAYER_SECRET_ARN` | `ipredict/<env>/relayer` | AWS Secrets Manager secret ID/ARN |
| `RELAYER_GRACE_MS` | `60000` | Grace window in ms for in-flight txns to settle |

## Rotate Everything

```bash
ts-node backend/scripts/rotate-secrets.ts --target=all --restart-ecs
```

## ECS Rolling Restart

Passing `--restart-ecs` triggers a rolling update (`forceNewDeployment=true`)
on the backend, indexer, and oracle ECS services after rotation. The old tasks
stay healthy until the new tasks pass health checks, so there is no downtime.

```bash
# Restart only (no rotation)
# (Use after manually updating a secret in the AWS Console)
ts-node backend/scripts/rotate-secrets.ts --target=all --dry-run --restart-ecs
```

| Variable | Default | Description |
|---|---|---|
| `ECS_CLUSTER` | `ipredict-staging` | ECS cluster name |
| `AWS_REGION` | `us-east-1` | AWS region |

## Automated rotation via GitHub Actions

The `.github/workflows/secret-rotation.yml` workflow runs on a weekly schedule
and can also be triggered manually from the Actions tab.

Required repository secrets:
- `AWS_ROLE_ARN` – IAM role ARN with Secrets Manager + ECS permissions
- `DB_HOST`, `DB_NAME`, `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD`
- `DB_SECRET_ARN`, `RELAYER_SECRET_ARN`
- `ECS_CLUSTER`

## Verification in Staging

1. Run with `--dry-run` and confirm the planned role switch / keypair generation.
2. Run the real rotation and confirm the log reports:
   - Role provisioning and privilege grant.
   - Secrets Manager update.
   - Active role switch.
   - Drain window completion and old-role decommission.
   - Relayer key stored + grace window elapsed + old key reference removed.
3. Confirm the application continues serving requests throughout.
4. Confirm ECS tasks picked up the rotated credentials after restart.

## Rollback

**Database:** If rotation fails before the drain step, the previous role is
still active and no action is required. If it fails after the active-role
switch, re-run the script – the dual-user strategy means swapping back is just
another rotation in reverse.

**Relayer keys:** The `previous_public_key` field in the relayer secret is
retained for the grace period. If the oracle fails to start with the new key,
retrieve the previous key from CloudTrail / Secrets Manager version history
and re-run the rotation in reverse.
