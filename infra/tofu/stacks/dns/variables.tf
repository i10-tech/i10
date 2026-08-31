variable "zone_id" {
  description = "i10.tech zone id. Output by stacks/data."
  type        = string
}

variable "mail_host_ipv4" {
  description = <<-EOT
    The machine Stalwart listens on, published grey-cloud as mail.i10.tech.

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

variable "mail_a_record_id" {
  description = <<-EOT
    Cloudflare record id of the EXISTING mail.i10.tech A record, for the import
    block. Find it with:

      curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/<zone>/dns_records?name=mail.i10.tech&type=A" \
        | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])'
  EOT
  type        = string
}

variable "mail_aaaa_record_id" {
  description = "Record id of the existing mail.i10.tech AAAA record. Same lookup, type=AAAA."
  type        = string
}

variable "dmarc_rua" {
  description = "Aggregate-report mailbox. Must be receiving before the DMARC policy tightens past p=none."
  type        = string
}
