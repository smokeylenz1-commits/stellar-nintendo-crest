<p align="center">
  <img src="frontend/public/logo.png" width="96" height="96" alt="iPredict logo" />
</p>

<h1 align="center">iPredict - Prediction Market on Stellar</h1>

<p align="center">
  <a href="https://github.com/AkanEf);/ipredict-stellar/actions"><img src="https://img.shields.io/github/actions/workflow/status/AkanEf);/ipredict-stellar/ci.yml?branch=main&label=CI&logo=github" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Stellar-Soroban-blue?logo=stellar" alt="Stellar" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/tests-207%20passing-brightgreen" alt="Tests" />
</p>

**Predict. Win or Lose — You Always Earn.** Decentralized prediction market on Stellar with near-zero fees and 5-second finality.

---

## Live Demo

**Frontend:** [https://ipredict-stellar.vercel.app](https://ipredict-stellar.vercel.app)

## Demo Video

🎬 [Watch Full MVP Flow on Loom](https://www.loom.com/share/bbfa51fde81645eb9ca13eeba82bc695) — *Wallet connect → browse markets → place bet → view leaderboard → claim reward → referral flow*

## Deployed Contracts (Stellar Mainnet)

| Contract | Address | Explorer |
|----------|---------|----------|
| Prediction Market | `CDGNPRYTFDXJLWZE4YDKZXW4IEN2RLPSE4N7VM5HJ7NLPL2QC45GIXI5` | [stellar.expert](https://stellar.expert/explorer/public/contract/CDGNPRYTFDXJLWZE4YDKZXW4IEN2RLPSE4N7VM5HJ7NLPL2QC45GIXI5) |
| IPREDICT Token | `CAYL4TKNRMXAX5ZLQGFEZ6XOC2QHTCTN5QC2SB5BEEHLVO6SDU2UBLRH` | [stellar.expert](https://stellar.expert/explorer/public/contract/CAYL4TKNRMXAX5ZLQGFEZ6XOC2QHTCTN5QC2SB5BEEHLVO6SDU2UBLRH) |
| Referral Registry | `CAGJVX6EXMCKKWDJCQFIEJ34CZTHZOGLWJM6KQTGDEXEO723CJZ5773H` | [stellar.expert](https://stellar.expert/explorer/public/contract/CAGJVX6EXMCKKWDJCQFIEJ34CZTHZOGLWJM6KQTGDEXEO723CJZ5773H) |
| Leaderboard | `CCWWOQSDSO3XXLCMA6A2HYRUFYVNUJZ2HPAMFQSPOB4JWYIBY2HWVTOB` | [stellar.expert](https://stellar.expert/explorer/public/contract/CCWWOQSDSO3XXLCMA6A2HYRUFYVNUJZ2HPAMFQSPOB4JWYIBY2HWVTOB) |

> **Network:** Stellar Mainnet (Public) | **Admin:** `GDZ4VJWNJPLNU3PAWDYX3V5XNATO7X257DPHWRPFXSCCNEUZ7QTXIIUI` | **7 seed markets live** | All contracts upgradeable
>
> **Native XLM SAC:** `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` (mainnet)

---

## TLS Certificate Monitoring & Renewal

Production API and frontend endpoints use Let's Encrypt TLS certificates that must be renewed periodically. Expired certificates cause browser warnings and full platform downtime, so renewal and expiry monitoring are automated.

### Automated Renewal (certbot)

Certbot runs on a systemd timer and renews certificates before they expire. A deploy hook reloads the web server only when a certificate is actually renewed.

```ini
# /etc/systemd/system/certbot-renew.timer
[Unit]
Description=Run certbot twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/certbot-renew.service
[Unit]
Description=Certbot renewal

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook /usr/local/bin/reload-tls.sh
```

```bash
#!/usr/bin/env bash
# /usr/local/bin/reload-tls.sh — reload web server after a successful renewal
set -euo pipefail
systemctl reload nginx
```

Enable the timer once on each host:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer
```

### Expiry Monitoring & Alerts

A cron job checks every certificate daily and alerts operations when a certificate has **fewer than 15 days** remaining, or when the automated renewal itself fails. The check exits non-zero on any alert so the failure is also visible to the scheduler.

```bash
#!/usr/bin/env bash
# /usr/local/bin/check-tls-expiry.sh
# Alerts operations when a TLS certificate has < 15 days remaining.
set -euo pipefail

THRESHOLD_DAYS=15
ALERT_WEBHOOK="${ALERT_WEBHOOK:?ALERT_WEBHOOK must be set}"
HOSTS=("api.ipredict-stellar.app:443" "ipredict-stellar.vercel.app:443")

fail=0
for host in "${HOSTS[@]}"; do
  end_date=$(echo | openssl s_client -servername "${host%%:*}" -connect "$host" 2>/dev/null \
    | openssl x509 -noout -enddate | cut -d= -f2)
  if [ -z "$end_date" ]; then
    msg="TLS check failed: could not read certificate for $host"
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"$msg\"}" "$ALERT_WEBHOOK" || true
    fail=1
    continue
  fi
  end_epoch=$(date -d "$end_date" +%s)
  now_epoch=$(date +%s)
  days_left=$(( (end_epoch - now_epoch) / 86400 ))
  if [ "$days_left" -lt "$THRESHOLD_DAYS" ]; then
    msg="TLS certificate for $host expires in ${days_left} days (< ${THRESHOLD_DAYS})"
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"$msg\"}" "$ALERT_WEBHOOK" || true
    fail=1
  fi
done
exit "$fail"
```

```cron
# /etc/cron.d/tls-expiry — daily certificate expiry check
0 6 * * * root ALERT_WEBHOOK=https://hooks.example.com/ops /usr/local/bin/check-tls-expiry.sh
```

### Alerting on Renewal Failure

The renewal service is paired with an `OnFailure` unit so operations are paged if certbot cannot renew a certificate:

```ini
# /etc/systemd/system/certbot-renew.service.d/alert.conf
[Unit]
OnFailure=certbot-renew-alert.service
```

```ini
# /etc/systemd/system/certbot-renew-alert.service
[Unit]
Description=Alert operations that certbot renewal failed

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"text":"certbot renewal FAILED — TLS certificates may expire"}' \
  https://hooks.example.com/ops
```

---

## Database Backup & Point-in-Time Recovery (PITR)

Off-chain indexer records and oracle dispute history live in PostgreSQL. To survive corruption or accidental deletion, the database is backed up daily and continuously archived so it can be restored to any point in time.

**Targets:** **RPO ≤ 5 minutes** (continuous WAL archiving) and **RTO ≤ 30 minutes** (restore base backup + replay WAL).

### Daily Base Backup + WAL Archiving

`pg_basebackup` takes a daily physical base backup, and PostgreSQL continuously archives WAL segments to an encrypted S3 bucket. Enable WAL archiving in `postgresql.conf`:

```conf
# postgresql.conf — continuous WAL archiving for PITR
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://ipredict-db-backups/wal/%f --sse AES256 --only-show-errors'
archive_timeout = 300   # force a WAL switch at least every 5 minutes (RPO)
```

```bash
#!/usr/bin/env bash
# /usr/local/bin/pg-base-backup.sh — daily encrypted base backup to S3
set -euo pipefail

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${BACKUP_BUCKET:=s3://ipredict-db-backups}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="/var/backups/postgres/base-${STAMP}"
mkdir -p "$DEST"

# Physical base backup including the WAL needed to make it consistent.
pg_basebackup \
  --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --pgdata "$DEST" --wal-method=stream --checkpoint=fast --progress

# Encrypt at rest and upload to the remote bucket.
tar -C "$DEST" -czf - . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
  | aws s3 cp - "${BACKUP_BUCKET}/base/base-${STAMP}.tar.gz.enc" --sse AES256 --only-show-errors

# Retain 30 days of base backups locally and remotely.
find /var/backups/postgres -maxdepth 1 -name 'base-*' -mtime +30 -exec rm -rf {} +
aws s3 ls "${BACKUP_BUCKET}/base/" | awk '{print $4}' | sort | head -n -30 \
  | while read -r old; do aws s3 rm "${BACKUP_BUCKET}/base/${old}" --only-show-errors; done

rm -rf "$DEST"
echo "base backup ${STAMP} archived to ${BACKUP_BUCKET}"
```

```cron
# /etc/cron.d/pg-backup — daily base backup at 02:00 UTC
0 2 * * * postgres BACKUP_ENCRYPTION_KEY_FILE=/etc/ipredict/backup.key /usr/local/bin/pg-base-backup.sh
```

### Recovery Test Script

Run this on staging to prove a backup restores and replays to a chosen point in time. 

---

## Bets Table Partitioning (Quarterly Range Partitions)

The high-volume `bets` table is partitioned by `placed_at` using PostgreSQL declarative **RANGE** partitioning, one partition per calendar quarter (e.g. `bets_2026_q1`, `bets_2026_q2`). Partitioning is transparent to the application: existing `SELECT`/`INSERT`/`UPDATE` statements against `bets` require **no changes** — PostgreSQL routes rows to the correct partition automatically.

### Partitioned Table Definition

```sql
-- Parent partitioned table. The partition key (placed_at) must be part of the
-- primary key, so the PK is composite (id, placed_at).
CREATE TABLE bets (
    id          BIGSERIAL,
    market_id   TEXT        NOT NULL,
    account     TEXT        NOT NULL,
    amount      NUMERIC     NOT NULL,
    placed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, placed_at)
) PARTITION BY RANGE (placed_at);

-- Quarterly partitions. Bounds are [start, end) in UTC.
CREATE TABLE bets_2026_q1 PARTITION OF bets
    FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');
CREATE TABLE bets_2026_q2 PARTITION OF bets
    FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE bets_2026_q3 PARTITION OF bets
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE bets_2026_q4 PARTITION OF bets
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- A catch-all partition prevents INSERT failures if a quarter is not yet provisioned.
CREATE TABLE bets_default PARTITION OF bets DEFAULT;
```

### Automated Quarterly Partition Creation

A `SECURITY DEFINER` function provisions the partition for a given quarter (idempotent via `IF NOT EXISTS`), and a `pg_cron` job runs it monthly so the next quarter always exists ahead of time.

```sql
-- Creates bets_<year>_q<quarter> if it does not already exist.
CREATE OR REPLACE FUNCTION ensure_bets_partition(target_date TIMESTAMPTZ)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    q_start TIMESTAMPTZ := date_trunc('quarter', target_date);
    q_end   TIMESTAMPTZ := q_start + INTERVAL '3 months';
    part    TEXT := format('bets_%s_q%s',
                           to_char(q_start, 'YYYY'),
                           to_char(q_start, 'Q'));
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF bets FOR VALUES FROM (%L) TO (%L)',
        part, q_start, q_end
    );
END;
$$;

-- Provision the current and next quarter on demand.
SELECT ensure_bets_partition(now());
SELECT ensure_bets_partition(now() + INTERVAL '3 months');
```

```sql
-- pg_cron: run on the 1st of every month at 03:00 UTC to provision upcoming quarters.
SELECT cron.schedule(
    'ensure-bets-partitions',
    '0 3 1 * *',
    $$SELECT ensure_bets_partition(now() + INTERVAL '3 months');$$
);
```

### Maintenance Routine

Because each partition is bounded to a single quarter, `VACUUM` and `REINDEX` operate on far smaller relations, keeping autovacuum responsive and index rebuilds fast. Run maintenance per partition:

```sql
-- Vacuum/analyze a single quarter without touching the rest of the table.
VACUUM (ANALYZE) bets_2026_q1;

-- Rebuild indexes for one quarter only.
REINDEX TABLE bets_2026_q1;
```

To retire old data, detach the partition (cheap, metadata-only) and archive or drop it:

```sql
ALTER TABLE bets DETACH PARTITION bets_2025_q1;
-- ...archive bets_2025_q1, then:
DROP TABLE bets_2025_q1;
```

### Runbook Checklist

- **Monthly:** confirm the `ensure-bets-partitions` `pg_cron` job is scheduled and succeeding (`SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;`).
- **Quarterly:** verify the upcoming quarter's partition exists (`\d+ bets` or query `pg_inherits`).
- **Ongoing:** monitor `bets_default` — any rows landing there indicate a missing partition and should be backfilled into the correct quarter.
- **Retention:** detach and archive partitions older than the retention window rather than deleting rows in place.
