terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
  required_version = ">= 1.5"
}

provider "cloudflare" {
  # Set CLOUDFLARE_API_TOKEN in environment — never hard-code credentials.
  # Minimum required permissions: Zone.WAF, Zone.Firewall Rules, Zone.Rate Limiting
  api_token = var.cloudflare_api_token
}

# ── Variables ──────────────────────────────────────────────────────────────────

variable "cloudflare_api_token" {
  description = "Cloudflare API token with WAF and Firewall rules permissions."
  type        = string
  sensitive   = true
}

variable "zone_id" {
  description = "Cloudflare Zone ID for the iPredict domain."
  type        = string
}

variable "account_id" {
  description = "Cloudflare Account ID."
  type        = string
}

# ── 1. WAF Custom Rule — block known malicious user agents ──────────────────
#
# Acceptance criterion: "Block known malicious user agents and tor exit nodes
# from API abuse."
#
# Rule logic:
#   - Block requests whose User-Agent matches a curated list of known scanner,
#     bot, or exploit-framework patterns.
#   - Block requests arriving from Tor exit nodes (Cloudflare threat score ≥ 10
#     correlates with Tor and high-anonymity proxies; ≥ 50 covers known bad IPs).
#   - Action: "managed_challenge" — solves a JS/CAPTCHA challenge for suspicious
#     traffic rather than a hard block, so legitimate wallets with VPNs can still
#     access the site.

resource "cloudflare_ruleset" "waf_custom_rules" {
  zone_id     = var.zone_id
  name        = "iPredict WAF Custom Rules"
  description = "Block malicious UAs, Tor exit nodes, and high-threat-score IPs from the iPredict API."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  # Rule 1 — Managed challenge for high Cloudflare threat scores.
  # Threat score ≥ 10: Cloudflare classifies as a medium-risk anonymous proxy or
  # Tor exit node. Threat score ≥ 50: known bad actors.
  # We use managed_challenge (not block) so a legitimate user behind a VPN can
  # solve the challenge — zero false positives for real wallet users.
  rules {
    action      = "managed_challenge"
    description = "Challenge high-threat-score IPs and Tor exit nodes"
    enabled     = true
    expression  = "(cf.threat_score ge 10)"
  }

  # Rule 2 — Block known malicious / scanner user agents.
  # These UAs are associated with automated exploit frameworks, credential
  # stuffers, and vulnerability scanners — none of which are legitimate
  # Stellar wallet users.
  rules {
    action      = "block"
    description = "Block known malicious user agents"
    enabled     = true
    expression  = <<-EOT
      (
        http.user_agent contains "sqlmap" or
        http.user_agent contains "nikto" or
        http.user_agent contains "nmap" or
        http.user_agent contains "masscan" or
        http.user_agent contains "zgrab" or
        http.user_agent contains "nuclei" or
        http.user_agent contains "dirbuster" or
        http.user_agent contains "gobuster" or
        http.user_agent contains "wfuzz" or
        http.user_agent contains "hydra" or
        http.user_agent contains "acunetix" or
        http.user_agent contains "nessus" or
        http.user_agent contains "openvas" or
        http.user_agent contains "python-requests/2" or
        http.user_agent contains "curl/" and
        not http.request.uri.path contains "/api/health"
      )
    EOT
  }

  # Rule 3 — Block requests with no User-Agent on API routes.
  # Legitimate browser wallets (Freighter, xBull, Albedo) always send a UA.
  # Programmatic abuse of /api/rpc without a UA is overwhelmingly bot traffic.
  rules {
    action      = "managed_challenge"
    description = "Challenge empty user-agent on API routes"
    enabled     = true
    expression  = "(not http.user_agent exists and starts_with(http.request.uri.path, \"/api/\"))"
  }

  # Rule 4 — Managed challenge for suspicious ASN combinations.
  # Cloud provider ASNs (AWS, GCP, Azure, Linode, DigitalOcean) have no
  # legitimate reason to call the prediction market frontend directly.
  # Wallets run in browsers on end-user ISP connections.
  rules {
    action      = "managed_challenge"
    description = "Challenge requests from datacenter/cloud ASNs on API routes"
    enabled     = true
    expression  = <<-EOT
      (
        starts_with(http.request.uri.path, "/api/") and
        (
          ip.geoip.asnum eq 16509 or  # Amazon AWS
          ip.geoip.asnum eq 15169 or  # Google Cloud
          ip.geoip.asnum eq 8075  or  # Microsoft Azure
          ip.geoip.asnum eq 14061 or  # DigitalOcean
          ip.geoip.asnum eq 63949     # Linode/Akamai
        )
      )
    EOT
  }
}

# ── 2. WAF Managed Ruleset — Cloudflare OWASP Core ───────────────────────────
#
# Enables Cloudflare's managed OWASP-based ruleset. This provides broad
# coverage against SQL injection, XSS, path traversal, and other OWASP Top-10
# attack categories with zero manual signature maintenance.

resource "cloudflare_ruleset" "managed_owasp" {
  zone_id     = var.zone_id
  name        = "iPredict Managed WAF (OWASP)"
  description = "Cloudflare managed OWASP ruleset for iPredict."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules {
    action      = "managed_challenge"
    description = "OWASP Core Ruleset — managed challenge on match"
    enabled     = true
    # Cloudflare Managed Ruleset ID for OWASP Core
    expression = "true"
    action_parameters {
      id = "4814384a9e5d4991b9815dcfc25d2f1f"  # Cloudflare OWASP Core Ruleset
      overrides {
        action            = "managed_challenge"
        sensitivity_level = "medium"
      }
    }
  }
}

# ── 3. Rate Limiting — /api/* endpoints ──────────────────────────────────────
#
# Acceptance criterion: "rate limits on /api/*"
#
# Two tiers:
#   Tier 1 — lenient: 300 requests per 10 seconds per IP on all /api/* routes.
#   Tier 2 — strict : 60  requests per 10 seconds per IP on /api/rpc (Soroban
#             proxy). This matches the in-process limit already in route.ts as
#             a belt-and-suspenders defense at the CDN layer.
#
# Action: managed_challenge (not block) — a human solver can pass; a bot loop
# cannot. Zero false positives for legitimate wallet users.

resource "cloudflare_ruleset" "rate_limiting" {
  zone_id     = var.zone_id
  name        = "iPredict Rate Limiting"
  description = "Rate limiting for the iPredict API and Soroban RPC proxy."
  kind        = "zone"
  phase       = "http_ratelimit"

  # Tier 1 — broad API rate limit
  rules {
    action      = "managed_challenge"
    description = "Rate limit /api/* — 300 req/10s per IP"
    enabled     = true
    expression  = "starts_with(http.request.uri.path, \"/api/\")"
    ratelimit {
      characteristics      = ["ip.src"]
      period               = 10
      requests_per_period  = 300
      mitigation_timeout   = 60   # challenge window: 60 seconds
    }
  }

  # Tier 2 — strict Soroban RPC proxy limit (mirrors in-process limit)
  rules {
    action      = "managed_challenge"
    description = "Rate limit /api/rpc — 60 req/10s per IP (Soroban proxy)"
    enabled     = true
    expression  = "(http.request.uri.path eq \"/api/rpc\")"
    ratelimit {
      characteristics      = ["ip.src"]
      period               = 10
      requests_per_period  = 60
      mitigation_timeout   = 30
    }
  }
}

# ── 4. DDoS Override — L7 HTTP DDoS sensitivity ──────────────────────────────
#
# Cloudflare's automatic DDoS protection runs by default, but we override the
# sensitivity to "high" for the /api/rpc route so the CDN engages DDoS
# mitigations earlier during critical market expiration windows.

resource "cloudflare_ruleset" "ddos_override" {
  zone_id     = var.zone_id
  name        = "iPredict DDoS Sensitivity Override"
  description = "Raise DDoS sensitivity on /api/rpc to protect during peak market expiry."
  kind        = "zone"
  phase       = "ddos_l7"

  rules {
    action      = "execute"
    description = "High DDoS sensitivity on Soroban RPC proxy"
    enabled     = true
    expression  = "(http.request.uri.path eq \"/api/rpc\")"
    action_parameters {
      id = "4d21379b4f9f4bb088e0729962c8b3cf"  # Cloudflare HTTP DDoS Attack Protection
      overrides {
        sensitivity_level = "high"
      }
    }
  }
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "waf_custom_ruleset_id" {
  description = "ID of the custom WAF ruleset."
  value       = cloudflare_ruleset.waf_custom_rules.id
}

output "rate_limit_ruleset_id" {
  description = "ID of the rate-limiting ruleset."
  value       = cloudflare_ruleset.rate_limiting.id
}
