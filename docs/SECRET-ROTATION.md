# Secret Rotation Runbook

This runbook documents how to rotate database credentials and API keys using
`backend/scripts/rotate-secrets.ts`. The procedure is designed for
**zero-downtime** rotation.

## Prerequisites

- Node.js and `ts-node` available in the backend environment.
- Admin database credentials exported as environment variables:
  - `DB_HOST`, `DB_PORT`, `DB_NAME`
  - `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD`
- The currently active application role tracked in `DB_ACTIVE_ROLE`
  (defaults to `app_user_a`).

## Zero-Downtime Database Rotation (Dual-User)

The script uses a dual-user strategy so no connection is dropped mid-rotation:

1. **Provision** a standby role (`app_user_a` / `app_user_b`) with a freshly
   generated password.
2. **Grant** the standby role the same privileges as the active role.
3. **Switch** the active role pointer (`DB_ACTIVE_ROLE`) so new connections use
   the standby role.
4. **Drain** in-flight connections on the old role for `DB_DRAIN_MS`
   (default `30000`).
5. **Decommission** the old role by revoking membership and setting `NOLOGIN`.

### Run

```bash
# Preview without making changes
ts-node backend/scripts/rotate-secrets.ts --target=db --dry-run

# Execute the rotation
ts-node backend/scripts/rotate-secrets.ts --target=db
```

## API Key Rotation

A new API key is generated and activated, while the previous key remains valid
for a grace window (`API_KEY_GRACE_MS`, default `60000`) so callers can roll
over without downtime.

```bash
ts-node backend/scripts/rotate-secrets.ts --target=api
```

## Rotate Everything

```bash
ts-node backend/scripts/rotate-secrets.ts --target=all
```

## Verification in Staging

1. Run the rotation with `--dry-run` and confirm the planned role switch.
2. Run the real rotation and confirm the log reports the active role switch and
   decommission steps.
3. Confirm the application continues serving requests throughout (no dropped
   connections) and that new connections use the rotated role.
4. Confirm the old role is set to `NOLOGIN` after the drain window.

## Rollback

If a rotation fails before the drain step, the previous role is still active and
no action is required. If it fails after the switch, re-run the script to switch
back to the previous role.
