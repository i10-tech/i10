terraform {
  # 1.10 is the floor for `use_lockfile` on the s3 backend — native state
  # locking through conditional writes, which is what lets R2 hold state with
  # no DynamoDB anywhere in the picture.
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # No backend block and no encryption block. This stack creates the bucket
  # every other stack keeps its state in, so it cannot keep its own state
  # there. It runs with local state, once. See README.
}
