# S2 — platform. Machines.
#
# ⚠ THIS STACK IS DELIBERATELY EMPTY, AND THAT IS THE POINT.
#
# i10 runs on psl-vps today: same box, same tailnet, same k3s cluster, same
# CNPG operator. It has no machine of its own, so there is nothing to create.
#
# The `for_each` below iterates a map that is currently empty. Declaring the
# node shape now, while the count is zero, is what makes adding the first real
# machine a tfvars edit rather than a new resource written under time pressure
# — and it is the same reason the `i10` Argo AppProject was defined before i10
# existed. A boundary is free to create early and expensive to retrofit.
#
# WHEN THIS STOPS BEING EMPTY: extraction. i10 moves to its own box, and
# because every product boundary was drawn from day one, the move is a CNPG
# `bootstrap.recovery` from i10's own R2 archive onto the new machine — a
# documented operation, not a dump with a write freeze.

provider "hcloud" {
  # HCLOUD_TOKEN from the environment.
}

module "labels" {
  source = "../../modules/labels"

  env   = "prod"
  stack = "platform"
  role  = "app"
}

resource "hcloud_server" "node" {
  for_each = var.nodes

  name        = "${module.labels.name_prefix}-${each.key}"
  server_type = each.value.server_type
  image       = each.value.image
  location    = each.value.location
  labels      = module.labels.labels

  public_net {
    ipv4_enabled = true
    # ⚠ IPv6 IS NOT OPTIONAL ON A MAIL NODE. Receivers increasingly prefer it
    # and score its reputation separately from IPv4. The k3s cluster was
    # rebuilt dual-stack for exactly this, and dual-stack CANNOT be retrofitted
    # to a running k3s — it must be configured at creation.
    ipv6_enabled = true
  }

  lifecycle {
    # A machine is replaceable; the data on it is not. Anything durable lives
    # in R2 or a CNPG archive, so this stack may destroy a node — but never
    # silently, which is what the CI plan gate is for.
    ignore_changes = [image]
  }
}
