# S3 — DNS. The records i10 publishes on its own zone.
#
# This stack is small and it is the most product-critical thing in infra/,
# because two of these records are the reason customers can send mail at all
# and one of them decides whether i10 can ever change relay provider.

provider "cloudflare" {}

module "labels" {
  source = "../../modules/labels"

  env   = "prod"
  stack = "dns"
}

# ═══════════════════════════════════════════════════════════════════════════
# THE MAIL HOST — grey cloud, both families
# ═══════════════════════════════════════════════════════════════════════════
#
# ⚠ proxied = false, AND IT CAN NEVER BE TRUE. Cloudflare's proxy carries only
# HTTP and HTTPS. SMTP on 25/465/587 and IMAP on 993 cannot pass through it, so
# the mail host must resolve straight to the machine. Every other name on this
# zone is proxied; this one is the deliberate exception.
#
# The cost is real and worth stating: grey-clouding publishes the origin IP.
# The box stops being hidden the day i10's MX goes live. That is unavoidable
# for mail — an MX has to name a reachable host — not an oversight.
#
# ⚠ AAAA IS NOT DECORATION. Mail systems increasingly prefer IPv6 and score its
# reputation separately from IPv4, so a v4-only mail host is a sender with half
# a reputation. It is also why the k3s cluster was rebuilt dual-stack: before
# that, an AAAA would have resolved to a port nothing was listening on, which
# fails for v6-preferring senders ONLY — the worst shape a bug can take.

resource "cloudflare_dns_record" "mx_host_v4" {
  zone_id = var.zone_id
  name    = "mx"
  type    = "A"
  content = var.mail_host_ipv4
  ttl     = 300
  proxied = false
  comment = module.labels.comment
}

resource "cloudflare_dns_record" "mx_host_v6" {
  zone_id = var.zone_id
  name    = "mx"
  type    = "AAAA"
  content = var.mail_host_ipv6
  ttl     = 300
  proxied = false
  comment = module.labels.comment
}

# i10's own inbound mail.
resource "cloudflare_dns_record" "apex_mx" {
  zone_id  = var.zone_id
  name     = "@"
  type     = "MX"
  content  = "mx.i10.tech"
  priority = 10
  ttl      = 3600
  comment  = module.labels.comment
}

# ═══════════════════════════════════════════════════════════════════════════
# THE PORTABILITY RECORD
# ═══════════════════════════════════════════════════════════════════════════
#
# Customers publish `include:spf.i10.tech`. This record is what that include
# resolves to, and it holds the SES include on OUR side.
#
# The point is not cosmetic. Resend's customers are pinned to SES by their own
# DNS: changing relay provider would mean asking every one of them to edit a
# record. i10's would not — adding a second relay alongside SES, or swapping
# the sending path entirely, is a change to this one line.
#
# ⚠ IT BUYS HALF THE PORTABILITY, NOT ALL OF IT. The bounce MX is NOT
# swappable. Each customer's send.<domain> MX must point at
# feedback-smtp.<region>.amazonses.com, SES re-verifies it continuously, and
# RFC 2181 forbids an MX target that is a CNAME — so it cannot hide behind an
# i10 hostname. Leaving SES, or merely CHANGING AWS REGION, means every
# customer edits DNS. The region is chosen once: eu-central-1.
#
# ⚠ IT COSTS ONE OF THE CUSTOMER'S TEN SPF LOOKUPS. Keep this record to a
# single include; each mechanism added here is spent from every customer's
# budget, and exceeding ten makes SPF fail permerror for all of them at once.
resource "cloudflare_dns_record" "spf_include" {
  zone_id = var.zone_id
  name    = "spf"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 3600
  comment = "${module.labels.comment} — customers include this; do not add mechanisms"
}

# i10's own sending, from i10.tech itself.
resource "cloudflare_dns_record" "apex_spf" {
  zone_id = var.zone_id
  name    = "@"
  type    = "TXT"
  content = "\"v=spf1 include:spf.i10.tech ~all\""
  ttl     = 3600
  comment = module.labels.comment
}

# ⚠ START AT p=none AND MOVE UP ON EVIDENCE. Enforcing before the reports are
# clean quarantines your own mail, and for a company whose product is email
# that failure is also the demo. `rua` must be live before the policy tightens
# — a policy with nowhere to report is a policy nobody can verify.
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; rua=mailto:${var.dmarc_rua}; fo=1\""
  ttl     = 3600
  comment = module.labels.comment
}

# ═══════════════════════════════════════════════════════════════════════════
# THE WEB SURFACES — orange cloud
# ═══════════════════════════════════════════════════════════════════════════
#
# Proxied, unlike the mail host. Free IPv6 at the edge, and the origin stays
# hidden for everything that is not mail.
#
# ⚠ NEVER SET SSL MODE TO FLEXIBLE. Traefik redirects :80 to :443 permanently,
# so Flexible — which talks plain HTTP to the origin — produces a redirect loop
# that resolves only by changing this setting, and reads as an application bug.
locals {
  web_hosts = {
    "@"    = "apex"
    "www"  = "marketing"
    "app"  = "console"
    "api"  = "send API"
    "docs" = "documentation"
  }
}

resource "cloudflare_dns_record" "web" {
  for_each = local.web_hosts

  zone_id = var.zone_id
  name    = each.key
  type    = "A"
  content = var.edge_ipv4
  ttl     = 1 # 1 = automatic, which is required when proxied.
  proxied = true
  comment = "${module.labels.comment} — ${each.value}"
}

resource "cloudflare_dns_record" "web_v6" {
  for_each = local.web_hosts

  zone_id = var.zone_id
  name    = each.key
  type    = "AAAA"
  content = var.edge_ipv6
  ttl     = 1
  proxied = true
  comment = "${module.labels.comment} — ${each.value}"
}
