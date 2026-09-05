import type { DnsRecord, DomainStatus } from "@repo/contracts"
import { dkimRecordValue } from "./dkim.js"

/**
 * Delegated subdomains: the customer points three names at us and we serve
 * everything under them.
 *
 * ⚠ THREE SUBDOMAINS, NEVER THE WHOLE ZONE. Taking their apex would make i10
 * responsible for their website, their inbound MX and every other vendor's
 * verification record — so a bad day for our nameserver takes their marketing
 * site down, not just their mail. It also asks a company to hand its most
 * load-bearing infrastructure to a mail vendor, which established ones will
 * decline. Delegating only what we need is strictly better on both counts.
 *
 * ⚠ AND IT IS OPT-IN, PER DOMAIN. Manual records stay the default: they work
 * with no dependency on our DNS being up, and a customer who cannot change
 * nameservers at their registrar must still be able to send.
 */

/** A record as an authoritative server holds it. Not the customer-facing shape. */
export interface ZoneRecord {
  /** Fully qualified, no trailing dot. */
  name: string
  type: "SOA" | "NS" | "MX" | "TXT"
  content: string
  ttl: number
  /** MX only. */
  priority?: number
}

export interface Zone {
  /** The delegated apex, e.g. `mail.example.com`. */
  name: string
  records: ZoneRecord[]
}

/**
 * ⚠ A PORT, SO THE BOX IS NOT THE COMMITMENT. PowerDNS over our own Postgres is
 * what runs today because it costs nothing and the zone data becomes rows we
 * already own. Cloudflare or Route 53 later is an adapter, not a migration —
 * the zone contents below are the same either way.
 */
export interface DnsZones {
  /** ⚠ Replaces the zone wholesale. Idempotent: publishing twice is a no-op. */
  put(zone: Zone): Promise<void>
  remove(zoneName: string): Promise<void>
}

export interface DelegationInput {
  domain: string
  mailFromSubdomain: string
  bounceSubdomain: string
  bounceHost: string
  region: string
  dkimSelector: string | null
  dkimPublicKey: string | null
  spfInclude: string
  /** Our authoritative servers, in order. From `MAIL_NAMESERVERS`. */
  nameservers: readonly string[]
  ttl?: number
}

/** The three names a delegating customer points at us. */
export const delegatedZoneNames = (domain: string) => ({
  /** Everything DKIM, so a key can be rotated without touching their DNS. */
  dkim: `_domainkey.${domain}`,
  /** Both return paths. */
  mail: `mail.${domain}`,
  dmarc: `_dmarc.${domain}`,
})

/**
 * ⚠ THE SOA'S SERIAL IS A CONSTANT, AND THAT IS SAFE ONLY BECAUSE NOTHING
 * TRANSFERS THESE ZONES. A serial matters to a secondary deciding whether to
 * pull; with a single primary and no AXFR there is no such reader. The moment a
 * secondary exists — which is how this stops being a single point of failure —
 * this has to become a value that increases on every write.
 */
const SOA_SERIAL = 1

const soa = (zone: string, primary: string, ttl: number): ZoneRecord => ({
  name: zone,
  type: "SOA",
  ttl,
  // refresh, retry, expire, negative-cache — conventional values; the negative
  // TTL is deliberately short so a record we add appears quickly for a resolver
  // that already asked and got NXDOMAIN.
  content: `${primary} hostmaster.${zone} ${SOA_SERIAL} 10800 3600 604800 300`,
})

/**
 * The zones we serve for a delegated domain.
 *
 * ⚠ THE RETURN PATHS MOVE UNDER `mail.`, WHICH IS THE POINT. Delegating
 * `send.<domain>` and `bounce.<domain>` separately would be two more NS record
 * sets for the customer to add and two more chances to add one wrong. SES
 * accepts any subdomain as its MAIL FROM, so `send.mail.<domain>` costs
 * nothing — and it means changing a return path later is our edit, not theirs.
 */
export function delegatedZones({
  domain,
  mailFromSubdomain,
  bounceSubdomain,
  bounceHost,
  region,
  dkimSelector,
  dkimPublicKey,
  spfInclude,
  nameservers,
  ttl = 300,
}: DelegationInput): Zone[] {
  const names = delegatedZoneNames(domain)
  const primary = nameservers[0] ?? "localhost"

  const apex = (zone: string): ZoneRecord[] => [
    soa(zone, primary, ttl),
    ...nameservers.map((ns) => ({
      name: zone,
      type: "NS" as const,
      content: ns,
      ttl,
    })),
  ]

  const mailFrom = `${mailFromSubdomain}.${names.mail}`
  const bounce = `${bounceSubdomain}.${names.mail}`

  return [
    {
      name: names.mail,
      records: [
        ...apex(names.mail),
        {
          name: mailFrom,
          type: "MX",
          content: `feedback-smtp.${region}.amazonses.com`,
          ttl,
          priority: 10,
        },
        {
          name: mailFrom,
          type: "TXT",
          content: "v=spf1 include:amazonses.com ~all",
          ttl,
        },
        { name: bounce, type: "MX", content: bounceHost, ttl, priority: 10 },
        {
          name: bounce,
          type: "TXT",
          content: `v=spf1 include:${spfInclude} ~all`,
          ttl,
        },
      ],
    },
    {
      name: names.dkim,
      records: [
        ...apex(names.dkim),
        // ⚠ ABSENT UNTIL THE KEY EXISTS. An empty zone answers NOERROR for the
        // selector, which a verifier reads as "published but malformed" rather
        // than "not yet" — the first is a permanent failure, the second is not.
        ...(dkimSelector && dkimPublicKey
          ? [
              {
                name: `${dkimSelector}.${names.dkim}`,
                type: "TXT" as const,
                content: dkimRecordValue(dkimPublicKey),
                ttl,
              },
            ]
          : []),
      ],
    },
    {
      name: names.dmarc,
      records: [
        ...apex(names.dmarc),
        { name: names.dmarc, type: "TXT", content: "v=DMARC1; p=none;", ttl },
      ],
    },
  ]
}

/**
 * What a DELEGATING customer publishes: three NS record sets and nothing else.
 *
 * ⚠ SAME SHAPE AS THE MANUAL RECORDS, SO THE API DOES NOT FORK. A client
 * renders `records` and tells the customer to publish them; whether that is six
 * records or three delegations is our business, not theirs.
 */
export function delegationRecordsFor(
  domain: string,
  nameservers: readonly string[],
  status: DomainStatus,
): DnsRecord[] {
  const names = delegatedZoneNames(domain)
  return Object.values(names).flatMap((zone) =>
    nameservers.map((ns): DnsRecord => ({
      record: "NS",
      name: zone,
      type: "NS",
      ttl: "Auto",
      status,
      value: ns,
    })),
  )
}
