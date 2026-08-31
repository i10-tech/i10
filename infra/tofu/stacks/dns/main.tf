# S3 — DNS. The MAIL records on i10.tech, and only those.
#
# ⚠ THIS ZONE HAS TWO OWNERS, DELIBERATELY. A proxied wildcard `*.i10.tech`
# already covers every web surface — dash, auth, api, docs — and that record
# stays hand-managed in Cloudflare. Tofu owns the mail half: the host Stalwart
# answers on, the MX, SPF, DMARC, and the include customers point at.
#
# The split is by blast radius, not tidiness. A wrong web record is a 522 that
# somebody notices in a minute. A wrong SPF or DKIM record fails DMARC
# SILENTLY, while damaging sender reputation, and the first symptom is mail
# landing in spam days later. Those are the records that want a reviewed plan.
#
# ⚠ THE WILDCARD DOES NOT CONFLICT WITH ANY OF THIS. `spf.i10.tech` resolving
# as an A record to Cloudflare is irrelevant — SPF is a TXT lookup, and a TXT
# record at that name coexists with the wildcard's A.
#
# ⚠ NOT READY TO APPLY YET. The MX, SPF and DMARC records below describe mail
# that does not flow. Publishing an MX for a host with nothing listening on 25
# produces bounces rather than nothing. Apply this stack when Stalwart is up,
# not before — see the README.

provider "cloudflare" {}

module "labels" {
  source = "../../modules/labels"

  env   = "prod"
  stack = "dns"
  role  = "mail"
}

# ═══════════════════════════════════════════════════════════════════════════
# THE MAIL HOST — grey cloud, both families
# ═══════════════════════════════════════════════════════════════════════════
#
# ⚠ proxied = false, AND IT CAN NEVER BE TRUE. Cloudflare's proxy carries only
# HTTP and HTTPS. SMTP on 25/465/587 and IMAP on 993 cannot pass through it, so
# this name must resolve straight to the machine. Every other name on the zone
# is proxied; this is the deliberate exception.
#
# The cost is real: grey-clouding publishes the origin IP. The box stops being
# hidden the day i10's MX goes live. That is unavoidable for mail — an MX has
# to name a reachable host — not an oversight.
#
# ⚠ AAAA IS NOT DECORATION. Receivers increasingly prefer IPv6 and score its
# reputation separately from IPv4, so a v4-only mail host is a sender with half
# a reputation. It is also why the k3s cluster was rebuilt dual-stack: before
# that an AAAA would have resolved to a port nothing was listening on, which
# fails for v6-preferring senders ONLY — the worst shape a bug can take.
#
# Both records already exist, created by hand. They are IMPORTED rather than
# recreated, so `tofu apply` never has a window where the mail host does not
# resolve.

import {
  to = cloudflare_dns_record.mail_v4
  id = "${var.zone_id}/${var.mail_a_record_id}"
}

import {
  to = cloudflare_dns_record.mail_v6
  id = "${var.zone_id}/${var.mail_aaaa_record_id}"
}

resource "cloudflare_dns_record" "mail_v4" {
  zone_id = var.zone_id
  name    = "mail"
  type    = "A"
  content = var.mail_host_ipv4
  ttl     = 300
  proxied = false
  comment = module.labels.comment
}

resource "cloudflare_dns_record" "mail_v6" {
  zone_id = var.zone_id
  name    = "mail"
  type    = "AAAA"
  content = var.mail_host_ipv6
  ttl     = 300
  proxied = false
  comment = module.labels.comment
}

# i10's own inbound mail. Note this is the MX for OUR domain — it is not the
# bounce MX customers publish, which points at SES and is per-customer.
resource "cloudflare_dns_record" "apex_mx" {
  zone_id  = var.zone_id
  name     = "@"
  type     = "MX"
  content  = "mail.i10.tech"
  priority = 10
  ttl      = 3600
  comment  = module.labels.comment
}

# ═══════════════════════════════════════════════════════════════════════════
# THE PORTABILITY RECORD
# ═══════════════════════════════════════════════════════════════════════════
#
# Customers publish `include:spf.i10.tech`. This is what that resolves to, and
# it holds the SES include on OUR side.
#
# The point is not cosmetic. Resend's customers are pinned to SES by their own
# DNS: changing relay provider would mean asking every one of them to edit a
# record. i10's would not — adding a second relay, or swapping the sending path
# entirely, is a change to this one line.
#
# ⚠ IT BUYS HALF THE PORTABILITY, NOT ALL OF IT. The bounce MX is not
# swappable. Each customer's `send.<domain>` MX must point at
# `feedback-smtp.<region>.amazonses.com`, SES re-verifies it continuously, and
# RFC 2181 forbids an MX target that is a CNAME — so it cannot hide behind an
# i10 hostname. Leaving SES, or merely CHANGING AWS REGION, means every
# customer edits DNS. The region is chosen once: eu-central-1.
#
# ⚠ IT COSTS ONE OF THE CUSTOMER'S TEN SPF LOOKUPS. Keep this to a single
# include. Every mechanism added here is spent from every customer's budget,
# and exceeding ten makes SPF permerror for all of them at once.
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
# that failure is also the demo. `rua` must be receiving before the policy
# tightens — a policy with nowhere to report is one nobody can verify.
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; rua=mailto:${var.dmarc_rua}; fo=1\""
  ttl     = 3600
  comment = module.labels.comment
}
