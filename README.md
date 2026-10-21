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

Run this on staging to prove a backup restores and replays to a chosen point in time. It restores the latest base backup, replays archived WAL up to `RECOVERY_TARGET_TIME`, and verifies the database accepts connections.

```bash
#!/usr/bin/env bash
# /usr/local/bin/pg-restore-test.sh — validate backup restoration + PITR on staging
set -euo pipefail

: "${BACKUP_BUCKET:=s3://ipredict-db-backups}"
: "${RECOVERY_TARGET_TIME:?set RECOVERY_TARGET_TIME (e.g. 2024-01-01 12:00:00+00)}"
RESTORE_DIR=/var/restore/postgres
PGDATA="$RESTORE_DIR/data"

rm -rf "$RESTORE_DIR" && mkdir -p "$PGDATA"

# 1. Fetch and decrypt the most recent base backup.
LATEST=$(aws s3 ls "${BACKUP_BUCKET}/base/" | sort | tail -n1 | awk '{print $4}')
aws s3 cp "${BACKUP_BUCKET}/base/${LATEST}" - --only-show-errors \
  | openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY \
  | tar -C "$PGDATA" -xzf -

# 2. Configure PITR: restore WAL from S3 and stop at the target time.
cat >> "$PGDATA/postgresql.auto.conf" <<EOF
restore_command = 'aws s3 cp ${BACKUP_BUCKET}/wal/%f %p --only-show-errors'
recovery_target_time = '${RECOVERY_TARGET_TIME}'
recovery_target_action = 'promote'
EOF
touch "$PGDATA/recovery.signal"

# 3. Start the restored instance and wait for recovery to complete.
pg_ctl -D "$PGDATA" -o "-p 55432" -w start
until pg_isready -p 55432; do sleep 2; done

# 4. Verify the database is consistent and queryable.
psql -p 55432 -c 'SELECT pg_is_in_recovery();' | grep -q ' f' \
  && echo "PITR restore to ${RECOVERY_TARGET_TIME} verified" \
  || { echo "recovery did not complete"; exit 1; }

pg_ctl -D "$PGDATA" -w stop
```

### Recovery Runbook

1. **Declare incident** and freeze writes to the primary database.
2. **Identify target time** — the last known-good point before corruption (RPO ≤ 5 min).
3. **Provision a fresh instance** and restore the latest base backup from `s3://ipredict-db-backups/base/`.
4. **Replay WAL** by setting `restore_command` and `recovery_target_time` as in the test script, then promote.
5. **Validate** with `pg_isready` and a row-count sanity check on indexer/dispute tables.
6. **Repoint the application** to the recovered instance and resume writes.
7. **Post-mortem** — record actual RPO/RTO and adjust backup frequency if needed.

---
## User Validation

> The table below records our **pre-launch testnet validation** — 30+ real users
> who tested the full flow (bet, claim, referral) on Stellar Testnet before the
> mainnet launch. These are historical testnet wallets, kept here as proof of
> product testing. Live mainnet activity is on the contracts listed above.

### Pre-Launch Testnet Users

| # | Wallet Address | Action | Points |
|---|----------------|--------|--------|
| 1 | `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD` | Admin — Created markets, placed bets, claimed rewards | 83 |
| 2 | `GA5OIFR4TLRJC54B3FIDWHIQKVFGVOWQFE3NXIIGCGLSGTJRUY6RHR2Q` | Placed bets, claimed rewards, referral registration | 38 |
| 3 | `GAIWJS35TTF2XMYGHY6AX6YBGI4IG3RWSEL2FEXV3DESW5RITGPWIIED` | Placed bets, claimed rewards, referral registration | 29 |
| 4 | `GA7GFCGUDLWZ6DIDCNERHA5CI7MATE6NT3MKDVJKFYIM5Y543OTLO3UY` | Placed bets, referral registration | 20 |
| 5 | `GDMA5FFWVJIOTBLO4XZWW5O4DWPOO33TLUOFCQQ7GPGTIRU6WXHCT4ZM` | Placed bets, referral registration | 17 |
| 6 | `GCSX2AGJRP747DWRCB3YYCKTXHU5CC6YNQUZPOCWWGA4DTK2PY5R6MUH` | Placed bets, referral registration | 8 |
| 7 | `GDKC2TFZVEJ7M7W2DLJZYFHK4AMHFX4JZKDP5JPQODBR7OT7C3RULXXA` | Placed bets, referral registration | 8 |
| 8 | `GAKY6JQSSCJZ3MQENCYAWIOZWGDKQJI7BCP6ZB35WTQZCMTYZ6M67UQG` | Placed bets, referral registration | 8 |
| 9 | `GCR32ST6YU3PLIOW7R6LRCB7ZMSSLAROMZGRQTK5CSOGW4GMIGMQGN5V` | Referral registration | 5 |
| 10 | `GA2LXPEKNP4IYZ2UKD4YUOGWPYMTNHGNXQRR2X3XT52XKQ5UV6BZKNFR` | Referral registration | 5 |
| 11 | `GCY4URAJ2JKE3UHCAEZHG5CTMVBS54S5IWQEWU3IIJX2ROOZ55YQYSOV` | Referral registration | 5 |
| 12 | `GDSSMRFIF56YMGR7DJY2DBQNQNLGJHJ5AW2DP3QSNVJVR4US6DTTM5YV` | Referral registration | 5 |
| 13 | `GB7M36KOEMNREMS4KMCXKUUYSHAT4JWEXLQJOFOEV3OA5SCUYYFEPGVO` | Referral registration | 5 |
| 14 | `GDD7MQAP2OE4NTEHLKNSUGIUMJN24RQL72ZTJAYGCDVULNP67JLUYGQW` | Referral registration | 5 |
| 15 | `GDUF4W7CEIM3JFGZFW4PTLWGCY3G3JD5P4WZMA4C6QFODLC7M6ASC3PU` | Referral registration | 5 |
| 16 | `GCXEQC2DIPFWPVR4JMROCYSB6YMP6TW3Q2YEV3IXTCRE4ZGSURKVL5LT` | Referral registration | 5 |
| 17 | `GBDFA2O72OOCUII5NWWKQ6G7V2EZ6D3GDWIYMCMQFVOAHFVAAM33ZOFZ` | Referral registration | 5 |
| 18 | `GACER5XK5SMHR64FZOELYPPLJVRWFBDY5UWCBOEBSLNK266Q2L45YD2P` | Referral registration | 5 |
| 19 | `GDKZYMCENO7VCOHIZR

- Stellar Admin Wallet: `GDHQ6TNWZ4V2JVCDWEUVW7YKFBXCOQZRRUCT27LAKES3PGOE6JSZMSMD`

## Handsoff notes

<!-- handsoff-issue-113 -->
- #113: feat(monitoring): configure alert rules for stuck markets (>48h past expiry) and council inactivity
