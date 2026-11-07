# S1 - durable.
#
# Everything whose loss is unrecoverable, or whose identity must survive a full
# rebuild. Nothing here may be destroyed by an apply: every resource carries
# `prevent_destroy`, and the CI policy gate refuses a plan that deletes one.
#
# ⚠ IMPORT-ONLY, LIKE PSL'S. Both buckets were created by hand before this
# stack existed, so it adopts them rather than creating them - and that is the
# shape to keep, not a temporary accommodation.
#
# What it buys is the recovery property: this stack creates nothing, so the
# committed tfvars listing what to import IS a complete recipe for rebuilding
# the state. Lose the state file, re-run init, and the import blocks put it
# back. A stratum that CREATES loses that - forgetting it owns a bucket means
# importing every one by hand.
#
# An import block is evaluated during `plan`, which is read-only. A wrong id
# therefore fails before anything is touched - which is how the three-segment
# format `<account>/<bucket>/<jurisdiction>` was found. `default` unless a
# bucket was deliberately created under `eu` or `fedramp`; the API does not
# report it, so it has to be known rather than read back.

provider "cloudflare" {}

module "labels" {
  source = "../../modules/labels"

  env     = "global"
  stack   = "data"
  durable = true
}

# ── R2 ───────────────────────────────────────────────────────────────────────
#
# ⚠ SEPARATION IS A BUCKET, NEVER A PREFIX. R2 API tokens scope per bucket and
# have no prefix granularity at all, so "own prefix, own credentials" inside a
# shared bucket is unenforceable - a token scoped to a bucket reads all of it.
# Buckets are free; R2 bills storage and operations.

import {
  to = cloudflare_r2_bucket.files
  id = "${var.cloudflare_account_id}/i10/default"
}

resource "cloudflare_r2_bucket" "files" {
  account_id    = var.cloudflare_account_id
  name          = "i10"
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
}

import {
  to = cloudflare_r2_bucket.backups
  id = "${var.cloudflare_account_id}/i10-backups/default"
}

# ⚠ WEUR, NOT var.r2_location. The dashboard shows i10-backups in Western
# Europe (checked 2026-11-06) while every other i10 bucket is in Eastern Europe.
# A location is fixed at creation, so declaring the hint here would plan a
# replace that prevent_destroy refuses, failing every apply of this stack.
resource "cloudflare_r2_bucket" "backups" {
  account_id    = var.cloudflare_account_id
  name          = "i10-backups"
  location      = "weur"
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
}

# Message content: attachments now (#136, #168), bodies later (#188). Objects
# are content-addressed per tenant, `<tenant_id>/sha256/<hash>`.
#
# ⚠ PRIVATE, AND NOT `i10`. The files bucket sits behind cdn.i10.tech; nothing
# here may ever have a custom domain or the r2.dev URL. Customers reach content
# only through our API, behind the tenant check. Created by hand on 2026-09-29
# with no public access, then imported like the rest.
#
# ⚠ NO LIFECYCLE RULE, EVER. Objects are shared by every message that carries
# the same bytes, so an object's age says nothing about whether it is still
# referenced. Our own sweep deletes an object once its last reference is gone.

import {
  to = cloudflare_r2_bucket.content
  id = "${var.cloudflare_account_id}/i10-content/default"
}

resource "cloudflare_r2_bucket" "content" {
  account_id    = var.cloudflare_account_id
  name          = "i10-content"
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
}

import {
  to = cloudflare_r2_bucket.content_dev
  id = "${var.cloudflare_account_id}/i10-content-dev/default"
}

resource "cloudflare_r2_bucket" "content_dev" {
  account_id    = var.cloudflare_account_id
  name          = "i10-content-dev"
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
}

# Stalwart's blob store (#357): mailbox message bodies, attachments and Sieve
# scripts. Its keys are `<base32 hash>`, written and read only by Stalwart.
#
# ⚠ NOT i10-content. That bucket is the API's, and a token can read every
# object in a bucket it is scoped to, so sharing one would hand Stalwart the
# API's content and the API every mailbox. Private, created by hand on the same
# terms as i10-content, then imported.
#
# ⚠ NO LIFECYCLE RULE, EVER, for the same reason as i10-content: a blob is
# shared by every message with the same bytes, and Stalwart's blob purge
# deletes it once nothing references it.

import {
  to = cloudflare_r2_bucket.mail
  id = "${var.cloudflare_account_id}/i10-mail/default"
}

resource "cloudflare_r2_bucket" "mail" {
  account_id    = var.cloudflare_account_id
  name          = "i10-mail"
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
}

# ⚠ DO NOT PUT A BUCKET LOCK ON i10-backups. PSL learned this on its own
# archive: a lock tuned to one tool's prune horizon silently breaks a second
# tool that prunes on its own schedule. CNPG's Barman deletes expired WAL and
# base backups itself, which is why its R2 token needs Object Read AND WRITE,
# and why a lock would make it fail quietly underneath.

# ── The zone ─────────────────────────────────────────────────────────────────
#
# Read, not managed. The zone is an account-level object that predates this
# stack and destroying it would take the domain's DNS with it; a data source
# gives the id that stacks/dns needs without ever putting it in a delete plan.
data "cloudflare_zone" "i10_tech" {
  zone_id = var.cloudflare_zone_id
}
