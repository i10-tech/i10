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

variable "dmarc_rua" {
  description = "Aggregate-report mailbox. Must be receiving before the DMARC policy tightens past p=none."
  type        = string
}

variable "record_ids" {
  description = <<-EOT
    Cloudflare record ids for the EXISTING records this stack adopts, keyed by
    resource name. Every record in main.tf has an `import` block reading this
    map, so the first apply adopts the zone rather than recreating it — which
    matters because a recreate has a window where mail does not resolve.

    ⚠ ONE MAP RATHER THAN ONE VARIABLE PER RECORD. There are twenty-two of
    them; twenty-two variables would be twenty-two chances for a key and a
    resource to drift apart silently.

    They are facts about this zone, not secrets. Regenerate the whole map with:

      curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/<zone>/dns_records?per_page=100" \
        | python3 -c 'import sys,json;[print(r["type"],r["name"],r["id"]) for r in json.load(sys.stdin)["result"]]'

    ⚠ AN ID THAT NO LONGER EXISTS FAILS THE PLAN, WHICH IS THE POINT. If a
    record was deleted and recreated by hand, the import fails loudly instead of
    the apply quietly making a second copy.
  EOT
  type        = map(string)

  validation {
    condition = length(setsubtract([
      "mail_v4", "mail_v6", "imap", "smtp",
      "apex_mx", "send_mx",
      "apex_spf", "send_spf",
      "dkim_rsa", "dkim_ed25519",
      "ses_byodkim",
      "dmarc",
      "srv_imaps", "srv_submissions", "srv_imap_none", "srv_submission_none",
      "mta_sts",
    ], keys(var.record_ids))) == 0
    error_message = "record_ids is missing a key. Records this stack ADOPTS have an import block, so a missing id is a record that would be CREATED alongside the live one. One resource is deliberately absent from this list: spf_include, which never existed and is genuinely created here. Note that an EMPTY string satisfies this check and then fails the plan on a malformed import id — which is still the loud failure rather than a duplicate record, but it is not this validation catching it."
  }
}
