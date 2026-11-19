#!/usr/bin/env bash
#
# Automated daily PostgreSQL backup for the protocol backend.
#
# - Dumps the database with pg_dump (custom format, gzip-compressed)
# - Encrypts the dump with GPG using AES-256 before it ever leaves the host
# - Uploads the encrypted artifact to an S3-compatible bucket
# - Prunes local and remote backups older than RETENTION_DAYS (default 30)
#
# Intended to be invoked from cron, e.g.:
#   15 3 * * * /opt/protocol/backend/scripts/backup-db.sh >> /var/log/protocol-backup.log 2>&1
#
# Required environment variables:
#   DATABASE_URL          postgres connection string (postgres://user:pass@host:5432/db)
#   BACKUP_GPG_RECIPIENT  GPG key id/fingerprint used to encrypt the dump
#   S3_BUCKET             destination bucket name
#   S3_ENDPOINT           S3-compatible endpoint URL (e.g. https://s3.us-east-1.amazonaws.com)
#   AWS_ACCESS_KEY_ID     credentials for the S3-compatible store
#   AWS_SECRET_ACCESS_KEY
#
# Optional environment variables:
#   RETENTION_DAYS        number of days to keep backups (default: 30)
#   BACKUP_DIR            local staging directory (default: /var/backups/protocol)
#   S3_PREFIX             key prefix inside the bucket (default: db-backups)
#   AWS_DEFAULT_REGION    region for the S3 client (default: us-east-1)

set -euo pipefail

RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/protocol}"
S3_PREFIX="${S3_PREFIX:-db-backups}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

require_env() {
  local missing=0
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      log "ERROR: required environment variable $var is not set"
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    exit 1
  fi
}

require_env DATABASE_URL BACKUP_GPG_RECIPIENT S3_BUCKET S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

for bin in pg_dump gzip gpg aws; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "ERROR: required binary '$bin' not found in PATH"
    exit 1
  fi
done

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="protocol-db-${TIMESTAMP}"
DUMP_PATH="${BACKUP_DIR}/${BASENAME}.dump.gz"
ENC_PATH="${DUMP_PATH}.gpg"

cleanup() {
  # Remove the unencrypted intermediate artifact as soon as we are done with it.
  rm -f "$DUMP_PATH"
}
trap cleanup EXIT

log "starting backup ${BASENAME}"

# 1. Dump + gzip compression. Custom format keeps restore options open.
if ! pg_dump --no-owner --no-privileges --format=custom "$DATABASE_URL" | gzip -9 > "$DUMP_PATH"; then
  log "ERROR: pg_dump failed"
  exit 1
fi
log "dump written to ${DUMP_PATH} ($(du -h "$DUMP_PATH" | cut -f1))"

# 2. Encrypt with GPG using AES-256 before the artifact leaves the host.
if ! gpg --batch --yes --trust-model always \
    --recipient "$BACKUP_GPG_RECIPIENT" \
    --cipher-algo AES256 \
    --output "$ENC_PATH" \
    --encrypt "$DUMP_PATH"; then
  log "ERROR: gpg encryption failed"
  exit 1
fi
log "encrypted artifact written to ${ENC_PATH}"

# 3. Upload the encrypted artifact to the S3-compatible bucket.
S3_KEY="${S3_PREFIX}/${BASENAME}.dump.gz.gpg"
if ! aws --endpoint-url "$S3_ENDPOINT" s3 cp "$ENC_PATH" "s3://${S3_BUCKET}/${S3_KEY}" --only-show-errors; then
  log "ERROR: upload to s3://${S3_BUCKET}/${S3_KEY} failed"
  exit 1
fi
log "uploaded to s3://${S3_BUCKET}/${S3_KEY}"

# 4. Retention: prune local artifacts older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'protocol-db-*.dump.gz.gpg' \
  -mtime "+${RETENTION_DAYS}" -print -delete | while read -r f; do
  log "pruned local backup ${f}"
done

# 5. Retention: prune remote artifacts older than RETENTION_DAYS.
CUTOFF_EPOCH="$(date -u -d "-${RETENTION_DAYS} days" +%s 2>/dev/null || date -u -v-"${RETENTION_DAYS}"d +%s)"
aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
  --bucket "$S3_BUCKET" \
  --prefix "${S3_PREFIX}/" \
  --query 'Contents[].[Key,LastModified]' \
  --output text 2>/dev/null | while read -r key last_modified; do
  [ -z "$key" ] && continue
  obj_epoch="$(date -u -d "$last_modified" +%s 2>/dev/null || true)"
  [ -z "$obj_epoch" ] && continue
  if [ "$obj_epoch" -lt "$CUTOFF_EPOCH" ]; then
    aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://${S3_BUCKET}/${key}" --only-show-errors \
      && log "pruned remote backup s3://${S3_BUCKET}/${key}"
  fi
done

log "backup ${BASENAME} completed successfully"
