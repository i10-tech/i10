import type { DnsRecord, DomainStatus } from "@repo/contracts"

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

/**
 * ⚠ `~all`, NOT `-all`. A soft fail. A hard fail on a domain the customer also
 * sends from elsewhere — their own mail server, a CRM, a helpdesk — rejects
 * that mail outright the moment this record is published. The customer's SPF
 * record is theirs to tighten once they know what else sends as them.
 */
const SPF_VALUE = "v=spf1 include:amazonses.com ~all"

export interface RecordInput {
  domain: string
  /** The MAIL FROM label, e.g. `send`. Not the FQDN. */
  mailFromSubdomain: string
  region: string
  /** Easy DKIM's tokens. Empty until the identity exists. */
  dkimTokens: readonly string[]
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
  dkimTokens,
  status,
}: RecordInput): DnsRecord[] {
  const mailFrom = `${mailFromSubdomain}.${domain}`

  return [
    // ⚠ BOTH HALVES OF MAIL FROM, AND NEITHER IS OPTIONAL. Without the MX,
    // bounces go nowhere and SES refuses the identity; without the TXT, the
    // return path fails SPF and receivers treat the mail as unauthenticated.
    {
      record: "SPF",
      name: mailFrom,
      type: "MX",
      ttl: "Auto",
      status,
      value: feedbackHost(region),
      priority: 10,
    },
    {
      record: "SPF",
      name: mailFrom,
      type: "TXT",
      ttl: "Auto",
      status,
      value: SPF_VALUE,
    },
    // Easy DKIM: three CNAMEs pointing at Amazon, who hold the private keys.
    // Three of them so a key can be rotated without a gap in signing.
    ...dkimTokens.map((token): DnsRecord => ({
      record: "DKIM",
      name: `${token}._domainkey.${domain}`,
      type: "CNAME",
      ttl: "Auto",
      status,
      value: `${token}.dkim.amazonses.com`,
    })),
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
      ttl: "Auto",
      status,
      value: "v=DMARC1; p=none;",
    },
  ]
}
