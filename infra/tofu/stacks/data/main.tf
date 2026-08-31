# S1 — durable.
#
# Everything whose loss is unrecoverable, or whose identity must survive a full
# rebuild. Nothing here may be destroyed by an apply: every resource carries
# `prevent_destroy`, and the CI policy gate refuses a plan that deletes one.
#
# ⚠ IMPORT-ONLY, LIKE PSL'S. Both buckets were created by hand before this
# stack existed, so it adopts them rather than creating them — and that is the
# shape to keep, not a temporary accommodation.
#
# What it buys is the recovery property: this stack creates nothing, so the
# committed tfvars listing what to import IS a complete recipe for rebuilding
# the state. Lose the state file, re-run init, and the import blocks put it
# back. A stratum that CREATES loses that — forgetting it owns a bucket means
# importing every one by hand.
#
# An import block is evaluated during `plan`, which is read-only. A wrong id
# therefore fails before anything is touched — which is how the three-segment
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
# shared bucket is unenforceable — a token scoped to a bucket reads all of it.
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

resource "cloudflare_r2_bucket" "backups" {
  account_id    = var.cloudflare_account_id
  name          = "i10-backups"
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
