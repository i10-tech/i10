# S0 — bedrock.
#
# The chicken-and-egg stratum: it creates the R2 bucket every other i10 stack
# stores state in. Applied once, then effectively frozen.
#
# Its own state is local and committed. That looks wrong and is not: the state
# holds one bucket name and no secrets, and the alternative is a bucket nothing
# can recreate if it is ever lost.
#
# ⚠ ITS OWN BUCKET, NOT A KEY INSIDE psl-tofu-state. R2 API tokens scope per
# BUCKET and never per prefix, so sharing a bucket means PSL's state token can
# read i10's state — and state carries whatever a stack read. Buckets are free.

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN from the environment. Needs R2 write on this account
  # and nothing else.
}

module "labels" {
  source = "../../modules/labels"

  env     = "global"
  stack   = "bootstrap"
  durable = true
}

resource "cloudflare_r2_bucket" "tofu_state" {
  account_id    = var.cloudflare_account_id
  name          = var.state_bucket_name
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

# NO VERSIONING AND NO BUCKET LOCK — both deliberate.
#
# R2 has no object versioning; the feature does not exist. Its nearest relative
# is a bucket lock, and a lock is actively WRONG here: locks prevent objects
# being deleted or OVERWRITTEN, and OpenTofu overwrites the state object on
# every apply. A lock on this bucket breaks the second apply.
#
# What replaces them is a property of the design. The durable stratum is
# import-driven: stacks/data creates nothing and imports only what its tfvars
# lists by id, so that committed file is already a complete recipe for
# rebuilding the state.
#
# That guarantee weakens the moment a stratum CREATES rather than imports. When
# stacks/platform holds a real machine, losing its state means OpenTofu has
# forgotten it owns one. Add this bucket to the nightly backup job at that
# point — timestamped copies, never overwritten.
