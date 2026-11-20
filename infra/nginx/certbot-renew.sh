#!/usr/bin/env bash
# =============================================================================
# certbot-renew.sh – Automated Let's Encrypt certificate renewal
#
# Renews certificates via the webroot plugin, then reloads Nginx gracefully so
# existing connections are not dropped. Designed to be called by a systemd
# timer or cron job.
#
# Usage:
#   sudo bash infra/nginx/certbot-renew.sh [--dry-run]
#
# Prerequisites:
#   - certbot installed  (apt install certbot python3-certbot-nginx)
#   - Nginx running and serving /.well-known/acme-challenge from /var/www/certbot
#   - Certificates already issued with:
#       certbot certonly --webroot -w /var/www/certbot -d <domain>
# =============================================================================
set -euo pipefail

DOMAIN="${IPREDICT_DOMAIN:-app.ipredict.xyz}"
WEBROOT="/var/www/certbot"
LOG_FILE="/var/log/certbot-renew.log"
DRY_RUN="${1:-}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting certificate renewal for ${DOMAIN}" | tee -a "$LOG_FILE"

# Ensure the webroot directory exists
mkdir -p "$WEBROOT"

# Attempt renewal (--quiet suppresses output when certificate is not yet due)
CERTBOT_ARGS=(
  certonly
  --webroot
  --webroot-path "$WEBROOT"
  --domain "$DOMAIN"
  --domain "www.${DOMAIN}"
  --non-interactive
  --agree-tos
  --quiet
  --deploy-hook "systemctl reload nginx"
)

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  CERTBOT_ARGS+=(--dry-run)
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Dry-run mode – no changes will be made" | tee -a "$LOG_FILE"
fi

certbot "${CERTBOT_ARGS[@]}" 2>&1 | tee -a "$LOG_FILE"

EXIT_CODE="${PIPESTATUS[0]}"
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Renewal check complete (exit 0 – may already be up to date)" | tee -a "$LOG_FILE"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: certbot exited with code ${EXIT_CODE}" | tee -a "$LOG_FILE"
  exit "$EXIT_CODE"
fi
