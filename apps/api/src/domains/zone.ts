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
  /**
   * This domain row's claim, which prefixes every nameserver name.
   *
   * ⚠ THE ZONE'S OWN NS RECORDS MUST MATCH WHAT THE PARENT PUBLISHES. A
   * delegation whose child zone names different nameservers than the parent is
   * "lame" — resolvers accept it, most of the time, and some caches do not.
   */
  claim: string
  /** Defaults to `RECORD_TTL`. Overridden only by tests. */
  ttl?: number
}

/**
 * The nameservers ONE claim delegates to.
 *
 * ⚠ PER CLAIM, NOT PER DEPLOYMENT, AND THAT IS WHAT MAKES THE DELEGATION PROVE
 * ITSELF. Every delegating customer used to publish the same `ns1.i10.tech` and
 * `ns2.i10.tech`, so nothing that reached DNS said which workspace had put it
 * there — a stranger could add a domain, publish nothing, and have the real
 * owner's NS records resolve to the stranger's zone. That is why there had to
 * be a separate challenge TXT record beside the delegation, carrying a token,
 * doing the identifying the delegation could not do.
 *
 * ⚠ GIVE THE CLAIM ITS OWN HOSTNAMES AND THE EXTRA RECORD DISAPPEARS. Only
 * somebody holding `example.com`'s DNS can publish
 * `mail.example.com NS <claim>.ns1.i10.tech`, and the label says whose claim it
 * is — the same property the DKIM selector already gives a manual domain, which
 * is why a manual domain never needed a challenge record either. One fact, read
 * out of the parent's referral by domains/referral.ts.
 *
 * ⚠ IT NEEDS A WILDCARD A RECORD ON EACH NAMESERVER NAME — `*.ns1.i10.tech` and
 * `*.ns2.i10.tech`, pointed at the nameserver's address and NOT PROXIED. Without
 * it every delegated label resolves to nothing and no zone is served at all.
 */
export const delegatedNameservers = (
  nameservers: readonly string[],
  claim: string,
): string[] => nameservers.map((ns) => `${claim}.${ns}`)

/** The three names a delegating customer points at us. */
export const delegatedZoneNames = (domain: string) => ({
  /** Everything DKIM, so a key can be rotated without touching their DNS. */
  dkim: `_domainkey.${domain}`,
  /** Both return paths. */
  mail: `mail.${domain}`,
  dmarc: `_dmarc.${domain}`,
})

/**
 * How long anything we publish may be cached, positively or negatively.
 *
 * ⚠ ONE CONSTANT FOR BOTH THE ZONES WE SERVE AND THE RECORDS WE WRITE INTO
 * SOMEBODY ELSE'S, because they are the same decision and drifted apart once
 * already. `dns/publish.ts` had its own `300` for the "Auto" case, so a change
 * here would have moved half of a delegation's TTLs and left the other half.
 *
 * ⚠ SIXTY SECONDS, AND THE NUMBER IS CHOSEN FOR THE MINUTE AFTER PUBLISHING
 * RATHER THAN FOR STEADY STATE. This TTL matters most in exactly one window:
 * somebody is watching a screen waiting for records to appear, and every
 * second of it is a second of somebody's attention. Sixty is the lowest value
 * every provider we write to accepts — Cloudflare's floor is 60, Hetzner's is
 * 60, DigitalOcean's is 30 — so it is the fastest we can be everywhere at once.
 *
 * ⚠ THE NEGATIVE TTL IS THE HALF THAT ACTUALLY BITES, AND IT IS THE LAST FIELD
 * OF THE SOA RATHER THAN A PROPERTY OF ANY RECORD. It governs how long a
 * resolver remembers that a name did NOT exist — so it is the cost of asking
 * one second too early, paid by whoever asks next. Ours was 300; for
 * comparison, Cloudflare publishes 1800 on the zones we delegate out of — half
 * an hour of remembering that a record was not there — which is why the
 * delegation proof reads the parent's nameservers directly rather than through
 * a recursive resolver. See `domains/referral.ts`.
 */
export const RECORD_TTL = 60

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
  // refresh, retry, expire, negative-cache. The last one is `RECORD_TTL` for
  // the reason given there: it is the one a resolver pays for asking early.
  content: `${primary} hostmaster.${zone} ${SOA_SERIAL} 10800 3600 604800 ${RECORD_TTL}`,
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
  claim,
  ttl = RECORD_TTL,
}: DelegationInput): Zone[] {
  const names = delegatedZoneNames(domain)
  const ours = delegatedNameservers(nameservers, claim)
  const primary = ours[0] ?? "localhost"

  const apex = (zone: string): ZoneRecord[] => [
    soa(zone, primary, ttl),
    ...ours.map((ns) => ({
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
  claim: string,
): DnsRecord[] {
  const names = delegatedZoneNames(domain)
  const ours = delegatedNameservers(nameservers, claim)
  /*
   * ⚠ SIX NS RECORDS AND NOTHING ELSE — THE CHALLENGE TXT RECORD IS GONE, and
   * its disappearance is the point rather than a simplification. It existed
   * only because every customer published the SAME two nameservers, so the
   * delegation said that somebody had delegated the name and nothing about who;
   * a seventh record had to carry the identity the first six could not.
   *
   * ⚠ NOW THE NAMESERVER NAMES CARRY IT. `<claim>.ns1.i10.tech` can only be
   * published by whoever holds this domain's DNS, and the label says whose
   * claim it is — so the delegation proves itself, exactly as a manual domain's
   * DKIM record always did. One less record to publish, one less to get wrong,
   * and one less thing to explain.
   */
  return Object.values(names).flatMap((zone) =>
    ours.map((ns): DnsRecord => ({
      record: "NS",
      name: zone,
      type: "NS",
      ttl: "Auto",
      status,
      value: ns,
    })),
  )
}
