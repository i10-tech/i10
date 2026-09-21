import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { DomainStore } from "./store.js"

/**
 * Asking SES about the domains that are still waiting on it.
 *
 * ⚠ NOTHING ASKED A SECOND TIME, AND THAT MADE US WRONG ABOUT OUR OWN STATE.
 * SES verifies a DKIM identity on its own schedule and announces it to nobody;
 * `domains_due_recheck` only reads domains that are ALREADY verified, because
 * its job is re-proving ownership. So between "we registered the identity" and
 * "somebody happens to press Verify at the right moment", the only thing
 * watching was the console's own poll — about a minute, on one open tab.
 *
 * ⚠ THE CONSEQUENCE WAS A CUSTOMER SENDING REAL MAIL FROM A DOMAIN OUR
 * DASHBOARD CALLED PENDING. SES had verified it, so SES accepted the send and
 * delivered it; our row still said `pending` and would have said so for ever.
 * The mail working is not the problem — being unable to say so is, and it gets
 * considerably worse the moment anything starts REFUSING sends on the strength
 * of that column. See the send gate in `send/accept.ts`: gating on
 * `verified_at` is only honest if something keeps `verified_at` current. This
 * is that something.
 *
 * ⚠ IT IS `DomainStore.refresh` IN A LOOP, NOT A SECOND WRITER. The rules for
 * what a status write may do — never move `verified_at` backwards, never
 * contest a name a poll happened to collide with — are subtle, already written
 * down once, and were got wrong once. A sweep with its own copy would be the
 * second place to get them wrong.
 *
 * ⚠ AND THE SELECTOR IS A DEFINER FUNCTION BECAUSE THE QUESTION SPANS TENANTS.
 * Every write underneath still goes through `withTenant`, so the row-level
 * policies apply exactly as they do on a request — only the "which rows are
 * waiting" read is privileged.
 */

export interface CatchUpDeps {
  db: Database
  /** The same store the API uses. Only `refresh` is called. */
  domains: Pick<DomainStore, "refresh">
  log?: { warn: (o: object, m: string) => void }
  now?: () => Date
  /**
   * How stale a domain's last check must be before it is asked again.
   *
   * ⚠ IT IS NOT THE CRON'S INTERVAL, AND THIS IS THE KNOB THAT ACTUALLY LIMITS
   * SES — WHICH IS WHY THE SCHEDULE COULD BE TIGHTENED WITHOUT COSTING
   * ANYTHING. The job runs every minute; this decides which rows a run is
   * allowed to touch. A domain is therefore asked about at most once per
   * `staleMs` no matter how often the job fires, so moving the schedule from
   * five minutes to one cut the time to notice by five and left the call volume
   * per domain exactly where it was.
   */
  staleMs?: number
  /**
   * How long after creation a domain is still considered to be waiting.
   *
   * ⚠ SES GIVES UP AFTER 72 HOURS, so beyond that nothing is going to change
   * and asking every minute spends an API call to be told so for ever.
   * Seven days is comfortably past it, which leaves room for a domain whose
   * records landed late without keeping abandoned ones alive indefinitely.
   */
  horizonMs?: number
  /** ⚠ BOUNDED, so one run cannot make thousands of SES calls. */
  batch?: number
}

export interface CatchUpSummary {
  /** Rows asked about. */
  checked: number
  /** Rows that turned out to be verified after all. */
  verified: number
  /** Rows the provider could not be asked about, or that would not write. */
  failed: number
}

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

interface WaitingRow {
  domain_id: string
  tenant_id: string
  name: string
}

export async function catchUpWithProvider({
  db,
  domains,
  log,
  now = () => new Date(),
  staleMs = MINUTE,
  horizonMs = 7 * DAY,
  /*
   * ⚠ SIZED FOR THE SLOT, NOT FOR THE TABLE. The job is killed at fifty
   * seconds so that a hung pass cannot block the next minute's run, and a
   * hundred SES calls fit inside that with room to spare. A backlog is not
   * lost: the selector orders oldest-first, so the next run picks up exactly
   * where this one stopped.
   */
  batch = 100,
}: CatchUpDeps): Promise<CatchUpSummary> {
  const summary: CatchUpSummary = { checked: 0, verified: 0, failed: 0 }

  const before = new Date(now().getTime() - staleMs)
  const createdAfter = new Date(now().getTime() - horizonMs)

  const waiting = (await db.execute(
    sql`select * from core.domains_awaiting_provider(
          ${before.toISOString()}::timestamptz,
          ${createdAfter.toISOString()}::timestamptz,
          ${batch}
        )`,
  )) as unknown as WaitingRow[]

  for (const row of waiting) {
    summary.checked += 1

    try {
      const outcome = await domains.refresh(row.tenant_id, row.domain_id)
      if (outcome.status === "ok" && outcome.domain.status === "verified") {
        summary.verified += 1
      }
    } catch (error) {
      /*
       * ⚠ ONE DOMAIN MUST NOT ABANDON THE REST. A throttled SES call, a
       * credential that lost a permission, a row deleted between the read and
       * the write — none of them says anything about the other ninety-nine
       * domains in this batch, and stopping at the first would
       * leave every later one stale until somebody noticed by hand.
       */
      summary.failed += 1
      log?.warn(
        { err: String(error), domain: row.name, domainId: row.domain_id },
        "could not ask the provider about a domain that is waiting on it",
      )
    }
  }

  return summary
}
