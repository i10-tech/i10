variable "nodes" {
  description = <<-EOT
    Compute nodes, keyed by short name. EMPTY UNTIL i10 LEAVES psl-vps.

    Sizing note when the first one lands: the shared CX33 is 4 vCPU / 8 GB and
    already carries k3s, Traefik, Argo, CNPG with two Postgres clusters,
    Redis, and ARC runners. ARC is the spiky one — a build can eat the box and
    take production latency with it.
  EOT
  type = map(object({
    server_type = string
    image       = string
    location    = string
  }))
  default = {}
}
