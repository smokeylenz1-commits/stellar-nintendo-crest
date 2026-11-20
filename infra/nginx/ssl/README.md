# SSL / TLS key material

This directory holds the DH parameters file and any manually managed TLS
assets. **Private keys and certificates are never committed to the
repository** – they live in `/etc/letsencrypt/` on the server and are
managed entirely by Certbot.

## Generate DH parameters

Run once on the server (takes a few minutes):

```bash
openssl dhparam -out /etc/nginx/ssl/dhparam.pem 4096
```

The path `/etc/nginx/ssl/dhparam.pem` is referenced by `conf.d/ipredict.conf`.

## First-time certificate issuance

```bash
# Ensure Nginx is running (serves the ACME challenge)
sudo systemctl start nginx

# Issue the certificate
sudo certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --domain app.ipredict.xyz \
  --domain www.app.ipredict.xyz \
  --email ops@ipredict.xyz \
  --agree-tos \
  --no-eff-email

# Reload Nginx to pick up the new certificate
sudo systemctl reload nginx
```

## Automated renewal

Renewal is automated via the `certbot-renew.timer` systemd timer (fires twice
daily with a random delay up to 30 minutes). Certbot only renews when fewer
than 30 days remain on the certificate.

```bash
# Check timer status
systemctl list-timers certbot-renew.timer

# Trigger a manual dry-run
sudo bash /opt/ipredict/infra/nginx/certbot-renew.sh --dry-run
```
