# S3 — DNS. The MAIL records on i10.tech, and only those.
#
# ⚠ THIS ZONE HAS TWO OWNERS, DELIBERATELY. A proxied wildcard `*.i10.tech`
# already covers every web surface — dash, auth, api, docs — and that record
# stays hand-managed in Cloudflare. Tofu owns the mail half: the host Stalwart
# answers on, the MX, SPF, DKIM, DMARC, the client-provisioning records, and the
# include customers point at.
#
# The split is by blast radius, not tidiness. A wrong web record is a 522 that
# somebody notices in a minute. A wrong SPF or DKIM record fails DMARC
# SILENTLY, while damaging sender reputation, and the first symptom is mail
# landing in spam days later. Those are the records that want a reviewed plan.
#
# ⚠ EVERY RESOURCE HERE IS IMPORTED, AND THE FILE DESCRIBES WHAT IS LIVE RATHER
# THAN WHAT WE WISH WERE LIVE. Reconciled against the zone on 2026-09-02, when
# mail started flowing and it became clear the stack had never been applied —
# no `backend.hcl`, no `terraform.tfvars`, only the examples. Everything in the
# zone had been created by hand, and the values written here beforehand had
# drifted from it in ways that would have broken outbound mail on the first
# apply. See the README section "What the reconciliation changed".
#
# The contract this file now holds: `tofu plan` on an untouched zone is EMPTY.
# If it is not, either the zone was edited by hand or this file is stale, and
# both are worth knowing before anything is applied.

provider "cloudflare" {}

# ⚠ THE PROVIDER TAKES A FULLY QUALIFIED RECORD NAME. Provider v4 accepted a
# name relative to the zone and appended the rest; v5 does not, and a relative
# name here would differ from the fully qualified one the API returns — so every
# record would show a permanent diff after import. This stack was written in the
# v4 style and never applied, which is why that went unnoticed until 2026-09-02.
locals {
  domain = "i10.tech"
}

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
# HTTP and HTTPS. SMTP on 25/465 and IMAP on 993 cannot pass through it, so
# these names must resolve straight to the machine. Every other name on the zone
# is proxied; these are the deliberate exceptions.
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

import {
  to = cloudflare_dns_record.mail_v4
  id = "${var.zone_id}/${var.record_ids["mail_v4"]}"
}

resource "cloudflare_dns_record" "mail_v4" {
  zone_id = var.zone_id
  name    = "mail.${local.domain}"
  type    = "A"
  content = var.mail_host_ipv4
  ttl     = 60
  proxied = false
  comment = module.labels.comment
}

import {
  to = cloudflare_dns_record.mail_v6
  id = "${var.zone_id}/${var.record_ids["mail_v6"]}"
}

resource "cloudflare_dns_record" "mail_v6" {
  zone_id = var.zone_id
  name    = "mail.${local.domain}"
  type    = "AAAA"
  content = var.mail_host_ipv6
  ttl     = 60
  proxied = false
  comment = module.labels.comment
}

# ⚠ THESE TWO EXIST BECAUSE THE WILDCARD MAKES ABSENCE IMPOSSIBLE, AND THAT IS
# WORSE THAN IT SOUNDS.
#
# `*.i10.tech` is proxied, so every undeclared name resolves — to Cloudflare,
# which carries no mail ports. A client connecting to `imap.i10.tech:993` got a
# TCP connection that went nowhere and sat until it timed out. NXDOMAIN would
# have failed in milliseconds and the client would have moved on.
#
# It matters because Apple Mail has no autoconfiguration to fall back on: for an
# "Other Mail Account" it neither reads Thunderbird autoconfig nor speaks
# Autodiscover, so it GUESSES — `imap.<domain>`, `smtp.<domain>`, then
# `mail.<domain>`. The wildcard turned the first two guesses into timeouts, and
# the user saw minutes of "Verifying" followed by a demand to type the hostname
# by hand. Measured 2026-09-02.
#
# The general rule for this zone: any hostname a mail client might guess needs
# an explicit grey-cloud record, because the wildcard guarantees it resolves
# either way.

import {
  to = cloudflare_dns_record.imap
  id = "${var.zone_id}/${var.record_ids["imap"]}"
}

resource "cloudflare_dns_record" "imap" {
  zone_id = var.zone_id
  name    = "imap.${local.domain}"
  type    = "CNAME"
  content = "mail.i10.tech"
  ttl     = 3600
  proxied = false
  comment = "Apple Mail probes this first; must not fall to the proxied wildcard"
}

import {
  to = cloudflare_dns_record.smtp
  id = "${var.zone_id}/${var.record_ids["smtp"]}"
}

resource "cloudflare_dns_record" "smtp" {
  zone_id = var.zone_id
  name    = "smtp.${local.domain}"
  type    = "CNAME"
  content = "mail.i10.tech"
  ttl     = 3600
  proxied = false
  comment = "Apple Mail probes this first; must not fall to the proxied wildcard"
}

# ═══════════════════════════════════════════════════════════════════════════
# ROUTING
# ═══════════════════════════════════════════════════════════════════════════

# i10's own inbound mail. Note this is the MX for OUR domain — it is not the
# bounce MX customers publish, which points at SES and is per-customer.
import {
  to = cloudflare_dns_record.apex_mx
  id = "${var.zone_id}/${var.record_ids["apex_mx"]}"
}

resource "cloudflare_dns_record" "apex_mx" {
  zone_id  = var.zone_id
  name     = local.domain
  type     = "MX"
  content  = "mail.i10.tech"
  priority = 10
  ttl      = 1
  comment  = module.labels.comment
}

# ⚠ i10's OWN bounce MX, and the one record in this file that is not ours to
# design. SES re-verifies it continuously, and RFC 2181 forbids an MX target
# that is a CNAME — so it cannot hide behind an i10 hostname, and the REGION is
# baked into it. Changing region means editing this, and means every customer
# editing theirs. Chosen once: eu-central-1.
import {
  to = cloudflare_dns_record.send_mx
  id = "${var.zone_id}/${var.record_ids["send_mx"]}"
}

resource "cloudflare_dns_record" "send_mx" {
  zone_id  = var.zone_id
  name     = "send.${local.domain}"
  type     = "MX"
  content  = "feedback-smtp.eu-central-1.amazonses.com"
  priority = 10
  ttl      = 1
  comment  = module.labels.comment
}

# ═══════════════════════════════════════════════════════════════════════════
# SENDER AUTHENTICATION — SPF, DKIM, DMARC
# ═══════════════════════════════════════════════════════════════════════════

# ⚠ `mx`, NOT an SES include, AND THE DIFFERENCE IS LOAD-BEARING TODAY.
#
# i10 currently sends its own mail FROM Stalwart on mail.i10.tech, which is the
# MX — so `v=spf1 mx -all` passes, and Gmail confirms it (spf=pass, dmarc=pass,
# measured 2026-09-02).
#
# ⚠ THE MOMENT SES PRODUCTION ACCESS LANDS THIS MUST CHANGE, and forgetting is
# a silent failure: mail relayed through SES comes from IPs that are not the MX,
# so it would fail SPF, fail DMARC alignment, and go to spam without an error
# anywhere. The value then becomes:
#
#     v=spf1 mx include:spf.i10.tech -all
#
# together with a NEW `spf.i10.tech` TXT holding `v=spf1 include:amazonses.com
# ~all`. That indirection is the portability record — customers publish
# `include:spf.i10.tech`, so swapping or adding a relay is a change to one line
# here rather than a request to every customer to edit their DNS. It is not in
# this file yet because it does not exist in the zone yet, and this file
# describes the zone.
#
# ⚠ IT COSTS ONE OF THE CUSTOMER'S TEN SPF LOOKUPS. When it is added, keep it to
# a single include. Every mechanism is spent from every customer's budget, and
# exceeding ten makes SPF permerror for all of them at once.
import {
  to = cloudflare_dns_record.apex_spf
  id = "${var.zone_id}/${var.record_ids["apex_spf"]}"
}

resource "cloudflare_dns_record" "apex_spf" {
  zone_id = var.zone_id
  name    = local.domain
  type    = "TXT"
  content = "\"v=spf1 mx -all\""
  ttl     = 60
  comment = module.labels.comment
}

# SPF for the bounce subdomain SES returns delivery notifications to.
import {
  to = cloudflare_dns_record.send_spf
  id = "${var.zone_id}/${var.record_ids["send_spf"]}"
}

resource "cloudflare_dns_record" "send_spf" {
  zone_id = var.zone_id
  name    = "send.${local.domain}"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 1
  comment = module.labels.comment
}

# ── DKIM ───────────────────────────────────────────────────────────────────
#
# ⚠ TWO KEYS, TWO ALGORITHMS, AND BOTH ARE NEEDED. Stalwart signs every outbound
# message twice. Gmail reports the ed25519 signature as `dkim=neutral (no key)`
# — it does not implement RFC 8463 — and passes on the RSA one. That is the
# whole point of dual-signing: ed25519 for receivers that support it, RSA for
# everyone else, and DMARC alignment satisfied by whichever verifies.
#
# The private halves live in Stalwart's own database, generated at first boot.
# These are the public halves, and they are NOT derivable from anything in this
# repository — if the Stalwart database is ever lost, new keys are generated
# with new selectors and these records must be replaced. See the bootstrap
# runbook.
import {
  to = cloudflare_dns_record.dkim_rsa
  id = "${var.zone_id}/${var.record_ids["dkim_rsa"]}"
}

resource "cloudflare_dns_record" "dkim_rsa" {
  zone_id = var.zone_id
  name    = "v1-rsa-20260901._domainkey.${local.domain}"
  type    = "TXT"
  # Split into two quoted strings because a TXT record cannot hold more than
  # 255 bytes in one. Cloudflare stores the quoting verbatim, so it is part of
  # the value here.
  content = "\"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyOi5sbw8U2hdcXwKNy+7P5OOsfm++OcuK3F2IibaiiLBFpfe7gC3aaXIt1ofjWrEdwQ+pI4rxRWKi1Q8xfOyQ12fr+Pr9l/a+YgktAsIwZzCeFxwLS1YWlRVjDIUaarD4KJSpUdDNBxUabJGUku0RNEkzIBnhJc3drP6ft7s3u/1KwKwLe87nDHxp+XQp/vZ8\" \"B9gyUGc1JykrFuv3w9Zh5k8109yTuy9RVuJfSXz9ZRp761tiFt5+P8VKFt56jLv6JLZtS67PeVQkR8Qqbit8TlWVP7kaIl42YN5CDPq+zs1uUtAS8Wpwp36nonEuS6Z/ReKWoUYoABZ8FfUvPkW7QIDAQAB\""
  ttl     = 60
  comment = module.labels.comment
}

import {
  to = cloudflare_dns_record.dkim_ed25519
  id = "${var.zone_id}/${var.record_ids["dkim_ed25519"]}"
}

resource "cloudflare_dns_record" "dkim_ed25519" {
  zone_id = var.zone_id
  name    = "v1-ed25519-20260901._domainkey.${local.domain}"
  type    = "TXT"
  content = "\"v=DKIM1; k=ed25519; p=z71VscEd8/pzW8jxDb9DgAV7mwpvb7qbX+0gfmCl5oo=\""
  ttl     = 60
  comment = module.labels.comment
}

# SES signs on its own keys for the sending identity; these three CNAMEs are
# what AWS asks for and what it re-verifies. Their targets are opaque and
# account-specific — they cannot be regenerated from anything here, so losing
# them means re-verifying the identity in the SES console.
import {
  to = cloudflare_dns_record.ses_dkim_1
  id = "${var.zone_id}/${var.record_ids["ses_dkim_1"]}"
}

resource "cloudflare_dns_record" "ses_dkim_1" {
  zone_id = var.zone_id
  name    = "ev7sowd3fetmzzff4v252vqyt6if3gxb._domainkey.${local.domain}"
  type    = "CNAME"
  content = "ev7sowd3fetmzzff4v252vqyt6if3gxb.dkim.amazonses.com"
  ttl     = 1
  proxied = false
  comment = module.labels.comment
}

import {
  to = cloudflare_dns_record.ses_dkim_2
  id = "${var.zone_id}/${var.record_ids["ses_dkim_2"]}"
}

resource "cloudflare_dns_record" "ses_dkim_2" {
  zone_id = var.zone_id
  name    = "gya6k5uo7jwwc2gxzhtuawae5yjnd7mw._domainkey.${local.domain}"
  type    = "CNAME"
  content = "gya6k5uo7jwwc2gxzhtuawae5yjnd7mw.dkim.amazonses.com"
  ttl     = 1
  proxied = false
  comment = module.labels.comment
}

import {
  to = cloudflare_dns_record.ses_dkim_3
  id = "${var.zone_id}/${var.record_ids["ses_dkim_3"]}"
}

resource "cloudflare_dns_record" "ses_dkim_3" {
  zone_id = var.zone_id
  name    = "o3g6gpyj2mnmnh5a5db5trghcexmiqlb._domainkey.${local.domain}"
  type    = "CNAME"
  content = "o3g6gpyj2mnmnh5a5db5trghcexmiqlb.dkim.amazonses.com"
  ttl     = 1
  proxied = false
  comment = module.labels.comment
}

# Clerk sends i10's authentication mail — verification codes, password resets —
# from its own infrastructure on our domain. These are its DKIM keys and its
# return path. They are mail-authentication records, so they belong to this
# stack rather than to the hand-managed web half, for exactly the blast-radius
# reason at the top of this file: if they break, sign-in emails start failing
# DMARC and nobody sees an error.
import {
  to = cloudflare_dns_record.clerk_dkim_1
  id = "${var.zone_id}/${var.record_ids["clerk_dkim_1"]}"
}

resource "cloudflare_dns_record" "clerk_dkim_1" {
  zone_id = var.zone_id
  name    = "clk._domainkey.${local.domain}"
  type    = "CNAME"
  content = "dkim1.974jc88qjof5.clerk.services"
  ttl     = 3600
  proxied = false
  comment = module.labels.comment
}

import {
  to = cloudflare_dns_record.clerk_dkim_2
  id = "${var.zone_id}/${var.record_ids["clerk_dkim_2"]}"
}

resource "cloudflare_dns_record" "clerk_dkim_2" {
  zone_id = var.zone_id
  name    = "clk2._domainkey.${local.domain}"
  type    = "CNAME"
  content = "dkim2.974jc88qjof5.clerk.services"
  ttl     = 3600
  proxied = false
  comment = module.labels.comment
}

import {
  to = cloudflare_dns_record.clerk_mail
  id = "${var.zone_id}/${var.record_ids["clerk_mail"]}"
}

resource "cloudflare_dns_record" "clerk_mail" {
  zone_id = var.zone_id
  name    = "clkmail.${local.domain}"
  type    = "CNAME"
  content = "mail.974jc88qjof5.clerk.services"
  ttl     = 3600
  proxied = false
  comment = module.labels.comment
}

# ⚠ START AT p=none AND MOVE UP ON EVIDENCE. Enforcing before the reports are
# clean quarantines your own mail, and for a company whose product is email
# that failure is also the demo. `rua` must be receiving before the policy
# tightens — a policy with nowhere to report is one nobody can verify.
#
# ⚠ AND THERE MUST BE EXACTLY ONE OF THESE. RFC 7489 §6.6.3: more than one
# DMARC record at `_dmarc` and the domain is treated as having NO POLICY AT ALL.
# A duplicate does not conflict loudly, it silently disables DMARC. Tofu owning
# this record is the guard.
#
# `adkim=s; aspf=s` is strict alignment on both — the subdomain of the From
# domain must match exactly rather than merely share an organisational domain.
# Correct while i10 sends only from i10.tech; revisit before sending from a
# subdomain.
import {
  to = cloudflare_dns_record.dmarc
  id = "${var.zone_id}/${var.record_ids["dmarc"]}"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${local.domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; rua=mailto:${var.dmarc_rua}; adkim=s; aspf=s\""
  ttl     = 60
  comment = module.labels.comment
}

# ═══════════════════════════════════════════════════════════════════════════
# CLIENT PROVISIONING — RFC 6186
# ═══════════════════════════════════════════════════════════════════════════
#
# These tell a mail client where to connect without the user typing a port.
# Thunderbird and several others read them; Apple Mail, measured, does not —
# which is why the `.mobileconfig` profile exists and why `imap`/`smtp` above
# have to resolve.
#
# ⚠ THE SET MUST MATCH `SystemSettings.services` IN STALWART. That map drives
# both the autoconfig XML and the zone file Stalwart generates, and it is
# trimmed to imap and smtp because those are the only protocols reachable from
# the internet. Publishing an SRV for a protocol that is not exposed offers
# clients an account that can never connect — POP3 on 995 was doing exactly
# that until 2026-09-02.

import {
  to = cloudflare_dns_record.srv_imaps
  id = "${var.zone_id}/${var.record_ids["srv_imaps"]}"
}

resource "cloudflare_dns_record" "srv_imaps" {
  zone_id = var.zone_id
  name    = "_imaps._tcp.${local.domain}"
  type    = "SRV"
  ttl     = 3600
  comment = "RFC 6186 client autoconfiguration"
  data = {
    priority = 0
    weight   = 1
    port     = 993
    target   = "mail.i10.tech"
  }
}

import {
  to = cloudflare_dns_record.srv_submissions
  id = "${var.zone_id}/${var.record_ids["srv_submissions"]}"
}

resource "cloudflare_dns_record" "srv_submissions" {
  zone_id = var.zone_id
  name    = "_submissions._tcp.${local.domain}"
  type    = "SRV"
  ttl     = 3600
  comment = "RFC 6186 client autoconfiguration"
  data = {
    priority = 0
    weight   = 1
    port     = 465
    target   = "mail.i10.tech"
  }
}

# ⚠ TARGET `.` MEANS "NOT AVAILABLE HERE", AND IT IS AN ANSWER RATHER THAN AN
# OMISSION. RFC 6186 §3. i10 exposes 993 and 465 only — nothing listens on 143,
# and 587 is deliberately not published through the pod's hostPort. Without
# these two records a client probes both and waits out a timeout on each; with
# them it stops immediately.
import {
  to = cloudflare_dns_record.srv_imap_none
  id = "${var.zone_id}/${var.record_ids["srv_imap_none"]}"
}

resource "cloudflare_dns_record" "srv_imap_none" {
  zone_id = var.zone_id
  name    = "_imap._tcp.${local.domain}"
  type    = "SRV"
  ttl     = 3600
  comment = "RFC 6186 - no STARTTLS IMAP on 143"
  data = {
    priority = 0
    weight   = 0
    port     = 0
    target   = "."
  }
}

import {
  to = cloudflare_dns_record.srv_submission_none
  id = "${var.zone_id}/${var.record_ids["srv_submission_none"]}"
}

resource "cloudflare_dns_record" "srv_submission_none" {
  zone_id = var.zone_id
  name    = "_submission._tcp.${local.domain}"
  type    = "SRV"
  ttl     = 3600
  comment = "RFC 6186 - no submission on 587"
  data = {
    priority = 0
    weight   = 0
    port     = 0
    target   = "."
  }
}

# ═══════════════════════════════════════════════════════════════════════════
# TRANSPORT POLICY
# ═══════════════════════════════════════════════════════════════════════════

# ⚠ THE ID IS A CACHE KEY AND MUST BE BUMPED WHEN THE POLICY CHANGES. Senders
# fetch https://mta-sts.i10.tech/.well-known/mta-sts.txt, cache it for max_age
# (a week), and only re-fetch when this id changes. A policy edit that leaves
# the id alone reaches nobody until the cache expires.
#
# The value must match the id Stalwart serves in the policy body. Stalwart is
# currently on `mode: testing`, which reports failures and delivers anyway —
# the right setting until the TLS reports come back clean.
#
# There is no CNAME here: `mta-sts.i10.tech` is answered by the proxied
# wildcard, which is correct for this one because the policy is fetched over
# HTTPS and Traefik routes it. That is the only place in this file where the
# wildcard is load-bearing rather than a hazard.
import {
  to = cloudflare_dns_record.mta_sts
  id = "${var.zone_id}/${var.record_ids["mta_sts"]}"
}

resource "cloudflare_dns_record" "mta_sts" {
  zone_id = var.zone_id
  name    = "_mta-sts.${local.domain}"
  type    = "TXT"
  content = "\"v=STSv1; id=9815085895383824922\""
  ttl     = 3600
  comment = "MTA-STS policy id; bump when the policy changes"
}

# ═══════════════════════════════════════════════════════════════════════════
# NOT OWNED HERE, ON PURPOSE
# ═══════════════════════════════════════════════════════════════════════════
#
#   *.i10.tech          proxied wildcard covering every web surface
#   i10.tech (A)        the apex, proxied
#   accounts, clerk     Clerk's frontend CNAMEs — web, not mail
#   _doppler_…, _gh-…   ownership-verification TXT records
#
# All hand-managed in Cloudflare. Adding them here would mean an apply could
# take the marketing site down, which is the coupling the two-owner split
# exists to prevent.
#
# ⚠ TLSA records are NOT published and should not be. Stalwart's generated zone
# file offers 22 of them. DANE pins the certificate; cert-manager renews the
# wildcard every 60 days and nothing here would update the pins, so inbound
# delivery would break at the first renewal. They also do nothing without
# DNSSEC, which this zone does not have.
