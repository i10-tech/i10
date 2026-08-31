# The single source of truth for i10's labelling convention.
#
# Every stack calls this rather than hand-writing a label map. A typo'd label
# is a resource that the durable-delete guard silently stops protecting, and
# labels cannot be retrofitted usefully — a resource created without them is
# an orphan nobody can attribute later.
locals {
  # Hetzner label values must match
  #   [a-zA-Z0-9]([-_.a-zA-Z0-9]*[a-zA-Z0-9])?
  # and cap at 63 characters. Cloudflare comments are free-form, so Hetzner's
  # rules are the binding constraint and we normalise to them everywhere.
  labels = {
    for k, v in {
      "managed-by"  = "tofu"
      "i10-env"     = var.env
      "i10-stack"   = var.stack
      "i10-role"    = var.role
      "i10-durable" = var.durable ? "true" : "false"
    } : k => substr(replace(lower(v), "/[^a-z0-9._-]/", "-"), 0, 63)
  }
}
