# S1 — durable.
#
# Everything whose loss is unrecoverable, or whose identity must survive a full
# rebuild. Nothing here may be destroyed by an apply: every resource carries
# `prevent_destroy`, and the CI policy gate refuses a plan that deletes one.
#
# ⚠ i10 DIVERGES FROM PSL HERE, DELIBERATELY. PSL's durable stratum is
# import-only, because its buckets and IPs pre-dated OpenTofu. i10 is
# greenfield, so this stack CREATES its durable resources and then protects
# them. That is the better shape — but it costs the property PSL relies on for
# recovery: its committed tfvars is a complete recipe for rebuilding state,
# and ours is not, because Tofu here is the thing that knows it owns these
# buckets.
#
# The consequence, and it is not optional: THIS STACK'S STATE MUST BE BACKED
# UP. Timestamped copies of i10-tofu-state into the nightly job, never
# overwritten. Losing it means every bucket has to be imported by hand.

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

resource "cloudflare_r2_bucket" "files" {
  account_id    = var.cloudflare_account_id
  name          = "i10"
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle { prevent_destroy = true }
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
