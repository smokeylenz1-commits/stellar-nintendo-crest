#!/usr/bin/env bash
# Restore a PostgreSQL database from an encrypted backup produced by
# backup-db.sh. See backend/docs/backup-runbook.md for the full procedure.
#
# Usage: restore-db.sh <path-to-backup.sql.gz.gpg>
#
# Required env:
#   DATABASE_URL  target postgres connection string
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <path-to-backup.sql.gz.gpg>" >&2
  exit 1
fi

BACKUP_FILE="$1"
: "${DATABASE_URL:?DATABASE_URL is required}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore] backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

echo "[restore] decrypting and restoring ${BACKUP_FILE}"
gpg --batch --yes --decrypt "$BACKUP_FILE" \
  | gunzip \
  | psql --set ON_ERROR_STOP=1 "$DATABASE_URL"

echo "[restore] completed"
