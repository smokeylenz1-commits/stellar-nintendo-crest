# Input variables for the Cloudflare WAF/rate-limiting Terraform module.
# See main.tf for usage context.

variable "cloudflare_api_token" {
  description = <<-EOD
    Cloudflare API token with the following minimum permissions:
      - Zone > WAF > Edit
      - Zone > Firewall Rules > Edit
      - Zone > Rate Limiting > Edit
    Store this in your CI/CD secret store or Terraform Cloud workspace.
    Never commit it to version control.
  EOD
  type      = string
  sensitive = true
}

variable "zone_id" {
  description = <<-EOD
    The Cloudflare Zone ID of the iPredict domain.
    Found in Cloudflare Dashboard → Overview → right-hand sidebar → Zone ID.
  EOD
  type = string
}

variable "account_id" {
  description = <<-EOD
    The Cloudflare Account ID.
    Found in Cloudflare Dashboard → right-hand sidebar → Account ID.
    Required for account-scoped resources.
  EOD
  type = string
}
