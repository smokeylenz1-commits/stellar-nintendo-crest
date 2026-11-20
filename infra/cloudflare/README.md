# Cloudflare WAF & Rate Limiting — iPredict

Terraform configuration that provisions Cloudflare Web Application Firewall
(WAF) rules and rate-limiting policies to protect the iPredict frontend against
DDoS, bot abuse, and API scraping during critical market expiration windows.

Closes issue [#292](https://github.com/smokeylenz1-commits/stellar-nintendo-crest/issues/292).

---

## What is provisioned

| Resource | Description |
|---|---|
| `cloudflare_ruleset.waf_custom_rules` | Custom WAF rules: challenge high-threat-score IPs and Tor exit nodes; block known scanner/exploit UAs; challenge empty-UA requests on `/api/*`; challenge datacenter ASNs on `/api/*`. |
| `cloudflare_ruleset.managed_owasp` | Cloudflare managed OWASP Core ruleset at medium sensitivity. Covers SQLi, XSS, path traversal, and other OWASP Top-10 categories. |
| `cloudflare_ruleset.rate_limiting` | Two-tier rate limiting: 300 req/10s per IP on all `/api/*` routes; 60 req/10s per IP on `/api/rpc` (mirrors the in-process limit in `route.ts`). |
| `cloudflare_ruleset.ddos_override` | Raises HTTP DDoS sensitivity to "high" on `/api/rpc` so Cloudflare's automatic mitigation engages earlier during peak market expiry. |

### Acceptance criteria coverage

- **Block known malicious user agents and Tor exit nodes from API abuse** →
  Custom rules #1 (Tor/threat score), #2 (malicious UAs), #3 (empty UA on `/api/*`).
- **Challenge suspicious traffic before reaching origin servers** →
  `managed_challenge` action on threat-score, UA, and ASN rules; OWASP managed ruleset.
- **Zero false positives on legitimate wallet user interactions** →
  `managed_challenge` (not `block`) is used for all ambiguous signals so a
  human wallet user can pass the challenge; only clearly malicious UAs are hard-blocked.

---

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5
- Cloudflare account with the iPredict zone added
- Cloudflare API token with **Zone > WAF > Edit**, **Zone > Firewall Rules > Edit**,
  and **Zone > Rate Limiting > Edit** permissions

---

## Usage

```bash
cd infra/cloudflare

# 1. Copy the example vars file and fill in your credentials
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set cloudflare_api_token, zone_id, account_id

# 2. Initialise Terraform (downloads the Cloudflare provider)
terraform init

# 3. Preview the changes
terraform plan

# 4. Apply
terraform apply
```

> **Important:** `terraform.tfvars` contains your API token. It is listed in
> `.gitignore` and must never be committed.

---

## Rate limit design

The `/api/rpc` Soroban RPC proxy has two layers of rate limiting:

1. **In-process** (`frontend/src/app/api/rpc/route.ts`): 60 req/10s sliding
   window per IP, enforced in the Next.js Edge runtime.
2. **CDN** (this Terraform): 60 req/10s per IP at the Cloudflare layer,
   applied before the request ever reaches the origin server.

The CDN layer fires first. If a burst bypasses it (e.g. during a cold start),
the in-process layer catches it. Together they limit abuse to ≤ 6 req/s sustained
per client on the Soroban proxy, protecting the upstream QuickNode endpoint from
metered credit exhaustion during DDoS events.

---

## Updating rules

Add new `rules {}` blocks inside the appropriate `cloudflare_ruleset` resource,
then run `terraform plan && terraform apply`. Cloudflare applies rule changes
globally within seconds.

To temporarily disable a rule without removing it, set `enabled = false`.
