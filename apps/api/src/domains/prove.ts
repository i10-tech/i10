import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { DomainStore } from "./store.js"

/**
 * Trying again to prove the domains nobody has proved yet.
 *
 * ⚠ REGISTRATION HAD EXACTLY ONE ATTEMPT AND NO RETRY ANYWHERE. `verify` is the
 * only thing that may create an SES identity — deliberately, because SES keys
 * identities on the domain name inside ONE AWS account, so registering a name
 * before ownership is proved is how one workspace overwrites another's signing
 * key. That rule is right and this does not weaken it. What was missing is that
 * `verify` is reachable only from two HTTP routes, and the console calls it
 * once, about a second after writing the records. If DNS is not serving at that
 * instant — which is most of the time, and always on the manual path where the
 * customer publishes by hand hours later — the attempt fails and NOTHING EVER
 * MAKES A SECOND ONE.
 *
 * ⚠ AND NOTHING IN THE BACKGROUND COULD HAVE. `domains_awaiting_provider`
 * filters `status <> 'not_started'` because it asks SES about identities that
 * exist; `domains_due_recheck` reads `status = 'verified'` because it re-proves
 * domains that already passed; `DomainStore.refresh` — which is what the
 * console's own watch polls — returns `not_registered` for an unproved row and
 * writes nothing. So the console could poll for a minute, give up, and truthfully
 * report that it had changed nothing, while the onboarding copy promised
 * "verification continues without this page open". It did not.
 *
 * ⚠ IT IS `DomainStore.verify` IN A LOOP, NOT A SECOND PROVER. The rules for
 * what proving a domain may do — claim a delegation only after the challenge
 * resolves, publish the zone before asking SES, never move `verified_at`
 * backwards, register only once ownership holds — are subtle, already written
 * down once, and were got wrong more than once. A sweep with its own copy would
 * be the next place to get them wrong. This is the same argument `catch-up.ts`
 * makes about `refresh`, applied to the other half of the same feature.
 *
 * ⚠ WITH ONE POWER TAKEN AWAY: `contest: false`. A person pressing Verify may
 * take a name from a workspace that can no longer prove it — that is a
 * deliberate transfer, with somebody waiting for the answer. A cron doing it
 * across every unproved row in the table would migrate domains between
 * customers on its own schedule with nobody asking. `catch-up.ts` refuses the
 * same thing in its own words: a poll must never move a domain between
 * customers.
 */

export interface ProveDeps {
  db: Database
  /** The same store the API uses. Only `verify` is called. */
  domains: Pick<DomainStore, "verify">
  log?: { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void }
  now?: () => Date
  /**
   * How stale a domain's last check must be before it is asked again.
   *
   * ⚠ THIS, NOT THE CRON'S INTERVAL, IS WHAT LIMITS THE DNS QUERIES. The job
   * runs every minute; this decides which rows a run may touch, so a domain is
   * asked about at most once per `staleMs` however often the job fires.
   *
   * ⚠ AND IT IS LONGER THAN CATCH-UP'S MINUTE ON PURPOSE. That one makes a
   * single cheap `GetEmailIdentity`; this one runs a full ownership proof —
   * several DNS lookups against somebody else's nameservers, and for a
   * delegated domain a zone write as well. Two minutes is still far faster than
   * the "until a human notices" it replaces.
   */
  staleMs?: number
  /**
   * How long after creation a domain is still considered worth proving.
   *
   * ⚠ SOMEBODY WHO ABANDONED A SIGNUP SHOULD STOP COSTING DNS QUERIES. Seven
   * days matches the horizon `catch-up.ts` already uses, so the two sweeps give
   * up on the same schedule and a domain cannot be alive to one and dead to the
   * other.
   */
  horizonMs?: number
  /** ⚠ BOUNDED, so one run cannot make thousands of DNS queries. */
  batch?: number
}

export interface ProveSummary {
  /** Rows attempted. */
  checked: number
  /** Rows that proved and now hold an SES identity. */
  registered: number
  /** Still waiting on DNS. The ordinary answer, and not an error. */
  unproven: number
  /** Another workspace holds the name. Left alone; see `contest`. */
  claimed: number
  /** The attempt itself failed. */
  failed: number
}

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

interface WaitingRow {
  domain_id: string
  tenant_id: string
  name: string
  delegated: boolean
}

export async function proveWaitingDomains({
  db,
  domains,
  log,
  now = () => new Date(),
  staleMs = 2 * MINUTE,
  horizonMs = 7 * DAY,
  /*
   * ⚠ SMALLER THAN CATCH-UP'S HUNDRED, BECAUSE EACH ROW COSTS MUCH MORE. A
   * proof is several DNS lookups with a three-second bound each, against
   * nameservers we do not control, plus a zone write for a delegated domain.
   * Fifty fits inside the job's slot with room for the slow ones; a backlog is
   * not lost, because the selector orders oldest-first and the next run picks
   * up where this one stopped.
   */
  batch = 50,
}: ProveDeps): Promise<ProveSummary> {
  const summary: ProveSummary = {
    checked: 0,
    registered: 0,
    unproven: 0,
    claimed: 0,
    failed: 0,
  }

  const before = new Date(now().getTime() - staleMs)
  const createdAfter = new Date(now().getTime() - horizonMs)

  const waiting = (await db.execute(
    sql`select * from core.domains_awaiting_proof(
          ${before.toISOString()}::timestamptz,
          ${createdAfter.toISOString()}::timestamptz,
          ${batch}
        )`,
  )) as unknown as WaitingRow[]

  for (const row of waiting) {
    summary.checked += 1

    try {
      const outcome = await domains.verify(row.tenant_id, row.domain_id, {
        contest: false,
      })

      switch (outcome.status) {
        case "ok":
          /*
           * ⚠ `ok` MEANS THE IDENTITY EXISTS NOW, NOT THAT SES HAS VERIFIED IT.
           * Ownership was proved and `CreateEmailIdentity` ran; Amazon's own
           * DKIM check follows on its own schedule, and watching for THAT is
           * `catch-up.ts`'s job. The row has just left `not_started`, which is
           * precisely what makes it visible to that sweep for the first time.
           */
          summary.registered += 1
          log?.info?.(
            {
              domain: row.name,
              domainId: row.domain_id,
              status: outcome.domain.status,
            },
            "proved a domain that nobody had proved yet, and registered its identity",
          )
          break
        case "claimed":
          summary.claimed += 1
          break
        case "unproven":
          // The ordinary answer for a domain whose records are not up yet.
          summary.unproven += 1
          break
        default:
          /*
           * ⚠ `missing` REACHES HERE AND IS NOT WORTH A LINE. The row was
           * deleted between the selector's read and this write, which is an
           * ordinary race and not a failure of anything.
           */
          break
      }
    } catch (error) {
      /*
       * ⚠ ONE DOMAIN MUST NOT ABANDON THE REST. A nameserver that hung, a zone
       * write that failed, a throttled SES call — none of them says anything
       * about the other forty-nine rows in this batch, and stopping at the
       * first would leave every later one waiting until somebody noticed by
       * hand. The same rule `catch-up.ts` follows.
       */
      summary.failed += 1
      log?.warn(
        { err: String(error), domain: row.name, domainId: row.domain_id },
        "could not prove a domain that is waiting to be proved",
      )
    }
  }

  return summary
}
