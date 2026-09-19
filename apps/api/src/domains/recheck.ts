import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { proveDomain, type DnsProbes } from "./ownership.js"

/**
 * Asking, periodically, whether the workspaces holding verified domains still
 * own them.
 *
 * ⚠ VERIFICATION WAS ONE-SHOT AND DOMAINS OUTLIVE IT. A workspace that proved
 * `example.com` once kept the verified badge for ever — through the
 * registration lapsing, through somebody else buying it, through the records
 * being deleted. Nothing ever asked again, so a verified sending identity for a
 * domain somebody else now owns was a permanent state with no path out of it
 * except support.
 *
 * ⚠ AND IT IS DELIBERATELY MUCH MORE CAUTIOUS THAN THE CONTEST PATH. There, a
 * challenger has PROVED the name — positive evidence the domain has moved, and
 * enough to act on at once. Here there is no challenger and no evidence of
 * anything except an absence, and an absence has a dozen innocent causes: a
 * zone being migrated between providers, a record mid-edit, a registrar's
 * nameservers having an afternoon. So absence has to PERSIST, and the clock
 * lives in `proof_missing_since` rather than in this process.
 *
 * ⚠ A FAILURE TO ASK IS NEVER AN ANSWER. `unreachable` does not start the
 * clock, does not stamp the check, and does not count towards anything — the
 * row is simply left for the next run. Treating a resolver timeout as "they no
 * longer own it" would, during one bad afternoon at a large DNS provider,
 * quietly un-verify a large fraction of our customers at once.
 */

export interface RecheckDeps {
  db: Database
  probes: DnsProbes
  /** Our nameserver names, so a delegation can be matched against this claim. */
  nameservers: readonly string[]
  log?: { warn: (o: object, m: string) => void }
  now?: () => Date
  /**
   * How long a verified domain may keep failing before it is stood down.
   * Seven days: longer than any DNS migration, shorter than a billing period.
   */
  graceMs?: number
  /** How stale a domain's last check must be before it is asked again. */
  intervalMs?: number
  /** ⚠ BOUNDED, so one run cannot make thousands of DNS queries. */
  batch?: number
}

export interface RecheckSummary {
  checked: number
  proven: number
  /** Failed the check. Most of these are within the grace period. */
  missing: number
  /** Could not be asked. Left entirely alone. */
  unreachable: number
  /** Stood down: failing for longer than the grace period. */
  displaced: number
}

const DAY = 24 * 60 * 60 * 1000

interface DueRow {
  domain_id: string
  tenant_id: string
  name: string
  delegated: boolean
  delegation_token: string
  dkim_selector: string | null
  dkim_public_key: string | null
  proof_missing_since: string | Date | null
}

export async function recheckDomains({
  db,
  probes,
  nameservers,
  log,
  now = () => new Date(),
  graceMs = 7 * DAY,
  intervalMs = DAY,
  batch = 200,
}: RecheckDeps): Promise<RecheckSummary> {
  const summary: RecheckSummary = {
    checked: 0,
    proven: 0,
    missing: 0,
    unreachable: 0,
    displaced: 0,
  }

  const before = new Date(now().getTime() - intervalMs)
  const due = (await db.execute(
    sql`select * from core.domains_due_recheck(${before.toISOString()}::timestamptz, ${batch})`,
  )) as unknown as DueRow[]

  for (const row of due) {
    const proof = await proveDomain(
      probes,
      {
        name: row.name,
        delegated: row.delegated,
        delegationToken: row.delegation_token,
        dkimSelector: row.dkim_selector,
        dkimPublicKey: row.dkim_public_key,
      },
      nameservers,
    )

    summary.checked += 1

    if (!proof.proven && proof.reason === "unreachable") {
      /*
       * ⚠ NOTHING IS WRITTEN. Not the check timestamp, not the clock. The row
       * comes back in the next run exactly as it is now, which is the correct
       * behaviour for a question we failed to ask.
       */
      summary.unreachable += 1
      continue
    }

    await db.execute(
      sql`select core.note_domain_proof(${row.domain_id}::uuid, ${proof.proven})`,
    )

    if (proof.proven) {
      summary.proven += 1
      continue
    }

    summary.missing += 1

    /*
     * ⚠ THE CLOCK IS READ FROM BEFORE THIS RUN'S WRITE, which is what makes the
     * grace period a real window rather than a single reading. A row failing
     * for the first time has a null here and is only stamped; it becomes
     * eligible to be stood down one grace period later, having failed every
     * check in between.
     */
    const since = row.proof_missing_since ? new Date(row.proof_missing_since) : null
    if (!since || now().getTime() - since.getTime() < graceMs) continue

    await db.execute(sql`select core.displace_domain(${row.domain_id}::uuid)`)
    summary.displaced += 1

    log?.warn(
      {
        domain: row.name,
        tenantId: row.tenant_id,
        domainId: row.domain_id,
        failingSince: since.toISOString(),
      },
      "domain stood down: its proof has been missing for longer than the grace period",
    )
  }

  return summary
}
