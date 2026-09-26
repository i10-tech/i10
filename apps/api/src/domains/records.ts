import type { DnsRecord, DomainStatus } from "@repo/contracts"
import { RECORD_TTL, returnPathDomain, returnPathSpf } from "./zone.js"
import { dkimRecordValue } from "./dkim.js"

/**
 * The DNS a customer has to publish before their domain can send.
 *
 * ⚠ PURE, AND THAT IS WHAT MAKES IT TESTABLE AT ALL. Every value here ends up
 * pasted into somebody's DNS provider by hand; a typo in a hostname is a
 * customer who cannot send and cannot see why, and the only way to catch one is
 * to assert the exact strings without needing AWS or a database.
 *
 * ⚠ AND THE VALUES NAME AMAZON BECAUSE AMAZON SENDS THE MAIL. Being
 * Resend-compatible means the envelope matches — the keys, the status strings,
 * the shape of the array — not that the records point at Resend's hosts.
 */

/** SES's feedback host, per region. The MX for the custom MAIL FROM domain. */
const feedbackHost = (region: string) => `feedback-smtp.${region}.amazonses.com`

export interface RecordInput {
  domain: string
  /** The return path's label for both routes, e.g. `send`. Not the FQDN. */
  mailFromSubdomain: string
  region: string
  /** The DNS label the DKIM key is published under. */
  dkimSelector: string | null
  /** base64 SPKI DER. Not secret. `null` before the key exists. */
  dkimPublicKey: string | null
  /**
   * The domain whose SPF record lists our own MTAs, e.g. `_spf.i10.tech`.
   *
   * ⚠ A DEDICATED SUBDOMAIN RATHER THAN THE APEX. SPF allows ten DNS lookups
   * per evaluation and the apex's record has its own job — it says who may send
   * as i10.tech. Conflating the two means every customer's SPF inherits every
   * include we ever add for our own mail, and the limit is reached by a change
   * nobody connected to customer deliverability.
   */
  spfInclude: string
  /** What we currently believe about the domain, stamped on every record. */
  status: DomainStatus
}

/**
 * ⚠ EVERY RECORD CARRIES THE DOMAIN'S STATUS RATHER THAN ITS OWN. SES verifies
 * DKIM and MAIL FROM as units and does not report per-record results, so a
 * per-record status would be invented. Resend's shape has the field, so it is
 * present and it is honest about being the same answer repeated.
 */
export function dnsRecordsFor({
  domain,
  mailFromSubdomain,
  region,
  dkimSelector,
  dkimPublicKey,
  spfInclude,
  status,
}: RecordInput): DnsRecord[] {
  const returnPath = returnPathDomain(domain, mailFromSubdomain)

  return [
    /**
     * ⚠ ONE RETURN PATH FOR BOTH ROUTES, AND NEITHER HALF IS OPTIONAL. SES and
     * our relay both write `<label>.<domain>` as the envelope sender, so SPF
     * aligns with the customer's `From:` whichever way the mail leaves.
     * Without the MX, SES refuses the MAIL FROM and falls back to its own —
     * and it must be AMAZON'S MX, which is why there is only one: see
     * `returnPathDomain` for what that costs. Without the TXT, the return path
     * fails SPF on both routes.
     */
    {
      record: "SPF",
      name: returnPath,
      type: "MX",
      ttl: String(RECORD_TTL),
      status,
      value: feedbackHost(region),
      priority: 10,
    },
    {
      record: "SPF",
      name: returnPath,
      type: "TXT",
      ttl: String(RECORD_TTL),
      status,
      value: returnPathSpf(spfInclude),
    },
    /**
     * ⚠ ONE TXT HOLDING OUR OWN PUBLIC KEY — BYODKIM. Easy DKIM would be three
     * CNAMEs pointing at Amazon, who would then hold the private half and be
     * the only party able to sign. That forecloses the routing decision
     * entirely: a message sent through our own MTA would have no key. One key
     * we own signs on both routes, so the customer publishes this once and
     * never touches it again whichever way their mail leaves.
     */
    ...(dkimSelector && dkimPublicKey
      ? [
          {
            record: "DKIM",
            name: `${dkimSelector}._domainkey.${domain}`,
            type: "TXT" as const,
            ttl: String(RECORD_TTL),
            status,
            value: dkimRecordValue(dkimPublicKey),
          },
        ]
      : []),
    /**
     * ⚠ DMARC IS INCLUDED THOUGH RESEND LISTS IT SEPARATELY, and `p=none` is
     * deliberate. Since 2024 the large mailbox providers require a DMARC record
     * to exist for bulk senders, so a customer without one has a deliverability
     * problem we can see coming and they cannot. `none` asks for reports and
     * quarantines nothing, which is the only policy safe to hand somebody who
     * has not yet found out what else sends as their domain.
     */
    {
      record: "DMARC",
      name: `_dmarc.${domain}`,
      type: "TXT",
      ttl: String(RECORD_TTL),
      status,
      value: "v=DMARC1; p=none;",
    },
  ]
}
