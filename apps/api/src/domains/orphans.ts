import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { DomainIdentity } from "./identity.js"
import type { DnsZones } from "./zone.js"

/**
 * Finding what we are still holding for domains that no longer exist.
 *
 * ⚠ EVERY DELETE THIS PRODUCT HAS EVER DONE LEAKED, AND NOTHING COUNTED IT.
 * `remove` tidies the SES identity and the three zones behind a deleted domain,
 * and is deliberately allowed to fail doing either — the row is already gone,
 * and a 500 the customer cannot act on is worse than a leak. That was a sound
 * trade against an occasional failure. It was not a trade against a CONSTANT
 * one: `ses:DeleteEmailIdentity` was missing from the IAM policy for most of
 * this product's life, so every identity delete returned AccessDenied and every
 * deleted domain left a live, billable, still-sendable identity behind. The
 * zone half had its own version — `holdsZones` read a missing claim row as "not
 * mine", which was true of every domain created before claims existed.
 *
 * ⚠ SO THE TIDY IS NOT ENOUGH ON ITS OWN, AND NEVER WAS. Anything allowed to
 * fail quietly needs something that notices, or the failures are invisible
 * until somebody reads an AWS bill or a DNS answer they cannot explain. This is
 * that something.
 *
 * ⚠ IT IS THE MOST DANGEROUS JOB IN THIS CODEBASE, and it is written to be
 * boring about it. Deleting a live sending identity stops a customer's mail
 * with no warning and no undo, so every removal here has to clear TWO
 * independent tests — our database does not know the name, AND the thing itself
 * carries our own fingerprint — and anything it cannot prove twice it leaves
 * alone and reports. Leaving an orphan costs a few cents and a log line.
 */

/** ⚠ `i10` AND TWELVE HEX, which is exactly what `generateSelector` produces. */
const OUR_SELECTOR = /^i10[0-9a-f]{12}$/

export interface OrphanDeps {
  db: Database
  /** Only the read-and-remove half of the port is used. */
  identity: Pick<DomainIdentity, "list" | "signature" | "remove">
  /** Absent on a deployment with no PowerDNS, which simply skips the zone half. */
  zones?: Pick<DnsZones, "remove">
  /**
   * The domains i10 itself sends from. `MAIL_DOMAINS`.
   *
   * ⚠ THEY HAVE ROWS, SO THEY WOULD SURVIVE THE FIRST TEST ANYWAY — and they are
   * named here regardless, because the cost of being wrong about them is our own
   * mail stopping, including every password reset and receipt this product
   * sends. A guard that is redundant today and catastrophic to be missing
   * tomorrow is worth its two lines.
   */
  ownDomains: readonly string[]
  /**
   * Whether to actually remove what it finds.
   *
   * ⚠ IT DEFAULTS TO FALSE, WHICH IS THE OPPOSITE OF EVERY OTHER SWEEP HERE AND
   * IS THE POINT. The others write idempotent status updates; this one issues
   * irreversible deletes against a live mail account, and the first run of it
   * on any deployment is the one with the most accumulated orphans and the
   * least evidence that its two tests are calibrated. So it reports first and
   * removes only when somebody has read the report and said so.
   */
  remove?: boolean
  log?: {
    warn: (o: object, m: string) => void
    info?: (o: object, m: string) => void
  }
  /** ⚠ BOUNDED, so a miscalibrated pass cannot delete the whole account. */
  batch?: number
}

export interface OrphanSummary {
  /** Identities SES reported. */
  identitiesSeen: number
  /** Identities with no domain row AND our own DKIM signature. */
  identitiesOrphaned: number
  /** Of those, actually deleted. Zero unless `remove`. */
  identitiesRemoved: number
  /**
   * Identities with no domain row that do NOT carry our signature.
   *
   * ⚠ REPORTED RATHER THAN REMOVED, AND COUNTED SEPARATELY SO IT CAN BE READ.
   * Somebody made these by hand in the AWS console. They are not ours to delete
   * and they are also not nothing — a growing number here means people are
   * working around the product.
   */
  identitiesForeign: number
  /** Zones with no domain row behind them. */
  zonesOrphaned: number
  /** Of those, actually deleted. Zero unless `remove`. */
  zonesRemoved: number
  /** Removals that were attempted and threw. */
  failed: number
}

interface OrphanZone {
  zone_id: string | number
  zone_name: string
  domain_name: string
}

export async function sweepOrphans({
  db,
  identity,
  zones,
  ownDomains,
  remove = false,
  log,
  batch = 100,
}: OrphanDeps): Promise<OrphanSummary> {
  const summary: OrphanSummary = {
    identitiesSeen: 0,
    identitiesOrphaned: 0,
    identitiesRemoved: 0,
    identitiesForeign: 0,
    zonesOrphaned: 0,
    zonesRemoved: 0,
    failed: 0,
  }

  const protectedNames = new Set(ownDomains)

  // ── SES identities ────────────────────────────────────────────────────────
  const listed = await identity.list()
  summary.identitiesSeen = listed.length

  const candidates = listed.filter((name) => !protectedNames.has(name))

  if (candidates.length > 0) {
    /*
     * ⚠ ONE QUERY FOR THE WHOLE SET, AND IT IS A DEFINER FUNCTION BECAUSE THE
     * QUESTION SPANS TENANTS. Asking through row level security would answer
     * "unknown" for every other workspace's domains and mark every one of their
     * live identities an orphan. See the note in migration 0052.
     */
    const rows = (await db.execute(
      sql`select * from core.domains_known(${candidates}::text[])`,
    )) as unknown as { name: string }[]
    const known = new Set(rows.map((r) => r.name))

    for (const name of candidates) {
      if (known.has(name)) continue

      /*
       * ⚠ THE SECOND TEST, AND NEITHER ONE IS SUFFICIENT ALONE. No row means
       * the product does not know the name; our own selector means the product
       * is what created it. Deleting on the first alone would take out every
       * identity anybody ever made by hand in the console.
       */
      const signed = await identity.signature(name)
      const ours =
        signed.origin === "EXTERNAL" &&
        signed.tokens.length > 0 &&
        signed.tokens.every((token) => OUR_SELECTOR.test(token))

      if (!ours) {
        summary.identitiesForeign += 1
        log?.info?.(
          { domain: name, origin: signed.origin },
          "an SES identity nothing in this database knows about, and not one we created — left alone",
        )
        continue
      }

      summary.identitiesOrphaned += 1

      if (!remove) {
        log?.warn(
          { domain: name },
          "orphaned SES identity: no domain row, our DKIM selector — would remove",
        )
        continue
      }

      if (summary.identitiesRemoved >= batch) continue

      try {
        await identity.remove(name)
        summary.identitiesRemoved += 1
        log?.warn({ domain: name }, "removed an orphaned SES identity")
      } catch (error) {
        summary.failed += 1
        log?.warn(
          { err: String(error), domain: name },
          "could not remove an orphaned SES identity",
        )
      }
    }
  }

  // ── PowerDNS zones ────────────────────────────────────────────────────────
  /*
   * ⚠ SKIPPED ENTIRELY WITHOUT A ZONE SINK, rather than reported and not acted
   * on. A deployment with no PowerDNS has no zones of ours to leak, and a
   * summary claiming otherwise would be noise on every run for ever.
   */
  if (zones) {
    const orphanZones = (await db.execute(
      sql`select * from core.orphaned_zones(${batch})`,
    )) as unknown as OrphanZone[]

    for (const zone of orphanZones) {
      // ⚠ EVEN HERE. A zone under one of our own sending domains is ours to
      // serve whatever the domains table says.
      if (protectedNames.has(zone.domain_name)) continue

      summary.zonesOrphaned += 1

      if (!remove) {
        log?.warn(
          { zone: zone.zone_name, domain: zone.domain_name },
          "orphaned zone: no domain row holds this name — would remove",
        )
        continue
      }

      try {
        await zones.remove(zone.zone_name)
        summary.zonesRemoved += 1
        log?.warn(
          { zone: zone.zone_name, domain: zone.domain_name },
          "removed an orphaned zone",
        )
      } catch (error) {
        summary.failed += 1
        log?.warn(
          { err: String(error), zone: zone.zone_name },
          "could not remove an orphaned zone",
        )
      }
    }
  }

  return summary
}
