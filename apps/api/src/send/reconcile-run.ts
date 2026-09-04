import type { Database } from "../db/client.js"
import type { AutumnClient, Logger } from "./autumn.js"
import {
  reconcile,
  sentUsageStatement,
  unbilledIdsStatement,
  type ReconcileResult,
  type UsageBucket,
} from "./reconcile.js"
import {
  billedButUnconfirmedStatement,
  needsAttention,
  orphanEventsStatement,
  repairFromSesStatement,
  sesSentButUnbilledStatement,
  type SesFinding,
  type SesReconcileReport,
} from "./reconcile-ses.js"

/**
 * Running the two send-side reconciliations.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE OTHER TWO WERE NEVER CALLED. `reconcile.ts` and
 * `reconcile-ses.ts` are pure — statements and arithmetic, tested to the last
 * boundary case — and nothing outside their own tests ever imported them. Every
 * argument they make about closing the gaps the hot path deliberately leaves
 * (`handle-batch.ts` logs "the reconciler will close the gap" on a swallowed
 * `recordSent`) described a job that did not run.
 *
 * ⚠ AND THE ORDER IS PART OF THE CORRECTNESS, NOT A PREFERENCE. The SES leg
 * repairs INTO `core.messages`; the Autumn leg reads `core.messages`. Run the
 * wrong way round, a message SES sent that we recorded late is repaired after
 * the count that would have billed it, and it waits a whole cycle. Run this way
 * round, it is simply an ordinary `sent` row by the time the second leg looks.
 *
 * ⚠ BOTH ARE READ-MOSTLY AND NEITHER SENDS MAIL. The SES leg's only write is
 * `repairFromSesStatement`, which refuses a row that is already `sent`; the
 * Autumn leg's only write is `track`, which is idempotent on the message id.
 * Running twice, or racing a second copy, cannot double-bill or re-send.
 */

/** How many findings of one kind a single pass will look at. */
const FINDING_LIMIT = 500

/**
 * ⚠ HOW MANY MESSAGES ONE PASS WILL TOP UP, AND IT IS A RATE LIMIT AS MUCH AS A
 * BUDGET. The top-up uses Autumn's single `track` — one request per message,
 * because only that endpoint takes an idempotency key — and Autumn rate-limits
 * to ten requests per second per organisation. A deficit larger than this is
 * carried to the next run rather than spent hammering them.
 */
const TOPUP_LIMIT = 200

type Row = Record<string, unknown>

const toDate = (v: unknown): Date => new Date(v as string | Date)

/**
 * Does SES agree with our books?
 *
 * ⚠ IT REPAIRS ONE DIRECTION AND ONLY REPORTS THE OTHER TWO, WHICH IS THE WHOLE
 * SHAPE OF reconcile-ses.ts. A message SES sent that we did not record is the
 * known, expected residue of the at-least-once design and is safe to write
 * down. A message we billed that SES never confirmed, and an event naming a
 * message we have no row for, are both ambiguous in ways where the automatic
 * fix would destroy the evidence — see the notes on each statement.
 */
export async function reconcileSes(
  db: Database,
  from: Date,
  log: Logger,
): Promise<SesReconcileReport> {
  const unbilledRows = (await db.execute(
    sesSentButUnbilledStatement(FINDING_LIMIT),
  )) as unknown as Row[]

  const unbilled: SesFinding[] = []
  for (const row of unbilledRows) {
    const messageId = String(row.message_id)
    const tenantId = String(row.tenant_id)

    // ⚠ ONE STATEMENT PER ROW, AND A FAILURE ON ONE MUST NOT ABANDON THE REST.
    // These are messages the customer has already received and we are not
    // billing for; stopping at the first awkward row would leave the rest
    // unbilled until somebody noticed by hand.
    try {
      const repaired = (await db.execute(
        repairFromSesStatement(
          messageId,
          toDate(row.created_at),
          toDate(row.ses_sent_at),
          row.ses_message_id ? String(row.ses_message_id) : null,
        ),
      )) as unknown as Row[]

      // No row back means it reached `sent` between the read and the write —
      // another pass, or the worker finishing late. Not a repair, not a
      // failure, and nothing to report either way.
      if (repaired.length > 0) unbilled.push({ messageId, tenantId })
    } catch (error) {
      log.error({ err: error, messageId, tenantId }, "could not repair from SES")
    }
  }

  const unconfirmed = (
    (await db.execute(
      billedButUnconfirmedStatement(from, FINDING_LIMIT),
    )) as unknown as Row[]
  ).map((r) => ({ messageId: String(r.message_id), tenantId: String(r.tenant_id) }))

  const orphaned = (
    (await db.execute(orphanEventsStatement(from, FINDING_LIMIT))) as unknown as Row[]
  ).map((r) => ({ messageId: String(r.message_id), tenantId: String(r.tenant_id) }))

  return { unbilled, unconfirmed, orphaned }
}

export interface UsageReport extends ReconcileResult {
  /** Messages this pass submitted to Autumn. */
  toppedUp: number
  /** Messages Autumn already had, which is the ordinary answer on a replay. */
  alreadyKnown: number
  /** Buckets we could not finish. Carried to the next run. */
  failed: number
}

/**
 * Did we bill for everything we sent?
 *
 * ⚠ THE DEFICIT IS TOPPED UP BY MESSAGE ID, NEVER BY COUNT. Autumn's `track`
 * answers 409 to a replayed idempotency key, so submitting the same message
 * again — two passes racing, one retried after a timeout — cannot double-bill.
 * Submitting "seventeen more" is not safe in the same way, and that difference
 * is why `unbilledIdsStatement` returns ids at all.
 *
 * ⚠ A SURPLUS IS REPORTED AND NEVER CORRECTED. Autumn counting more than we
 * sent means a duplicate was recorded somewhere, and issuing negative usage to
 * flatten it would erase the only evidence of that.
 */
export async function reconcileUsage(
  db: Database,
  entitlements: AutumnClient,
  from: Date,
  to: Date,
  log: Logger,
): Promise<UsageReport> {
  const ours: UsageBucket[] = (
    (await db.execute(sentUsageStatement(from, to))) as unknown as Row[]
  ).map((r) => ({
    tenantId: String(r.tenant_id),
    periodStart: toDate(r.period_start),
    count: Number(r.count),
  }))

  const theirs = await entitlements.aggregateByCustomer(from, to)
  const result = reconcile(ours, theirs)

  let toppedUp = 0
  let alreadyKnown = 0
  let failed = 0

  for (const bucket of result.deficits) {
    // The bucket is a day; its end is the start of the next one. Both sides
    // agree on `sent_at` in UTC, which is what makes the ids in this window the
    // ids the count was made of.
    const periodEnd = new Date(bucket.periodStart.getTime() + 86_400_000)

    try {
      const ids = (
        (await db.execute(
          unbilledIdsStatement(
            bucket.tenantId,
            bucket.periodStart,
            periodEnd,
            Math.min(bucket.deficit, TOPUP_LIMIT),
          ),
        )) as unknown as Row[]
      ).map((r) => String(r.id))

      for (const id of ids) {
        const outcome = await entitlements.track({
          customerId: bucket.tenantId,
          messageId: id,
          // ⚠ THE BUCKET'S OWN START, NOT `now()`. Autumn buckets on the event's
          // timestamp, so stamping the repair time would file the message in the
          // day it was noticed — and the next pass would then find the same
          // deficit in the original day and the same surplus in this one,
          // forever.
          at: bucket.periodStart,
        })
        if (outcome === "duplicate") alreadyKnown += 1
        else toppedUp += 1
      }
    } catch (error) {
      // ⚠ PER BUCKET, SO ONE TENANT'S PROBLEM IS NOT EVERY TENANT'S. The rows
      // are unchanged, so an unfinished bucket is simply found again by the
      // next run — but abandoning the loop would let one bad tenant block
      // everybody else's billing indefinitely.
      failed += 1
      log.error(
        { err: error, tenantId: bucket.tenantId, period: bucket.periodStart },
        "could not top up a usage bucket",
      )
    }
  }

  return { ...result, toppedUp, alreadyKnown, failed }
}

export { needsAttention }
