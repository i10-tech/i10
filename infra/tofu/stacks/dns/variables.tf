variable "zone_id" {
  description = "i10.tech zone id. Output by stacks/data."
  type        = string
}

variable "mail_host_ipv4" {
  description = <<-EOT
    The machine Stalwart listens on, published grey-cloud as mx.i10.tech.

    Today this is psl-vps, because i10 shares it. It becomes a remote-state
    read from stacks/platform the moment i10 has a node of its own — which is
    why it is a variable rather than a literal in main.tf.
  EOT
  type        = string
}

variable "mail_host_ipv6" {
  description = "The same machine's IPv6. Not optional for a mail host."
  type        = string
}

variable "edge_ipv4" {
  description = "Origin the proxied web records point at."
  type        = string
}

variable "edge_ipv6" {
  description = "Origin's IPv6 for the proxied web records."
  type        = string
}

variable "dmarc_rua" {
  description = "Aggregate-report mailbox. Must be receiving before the DMARC policy tightens."
  type        = string
}
