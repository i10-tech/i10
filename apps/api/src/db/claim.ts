import { sql, type SQL } from "drizzle-orm"

/**
 * Claiming a message for delivery.
 *
 * ⚠ THIS IS THE THING THAT STOPS TWO WORKERS SENDING THE SAME EMAIL, AND IT IS
 * NOT THE QUEUE. groupmq holds a lease in Redis — `reserve()` moves the job to a
 * `processing` set with a deadline, `heartbeat()` extends it, `checkStalledJobs()`
 * hands it back if the worker dies. That is exactly the visibility timeout the
 * design calls for, and it is a LIVENESS mechanism: it guarantees the job gets
 * picked up again, not that it is only ever executed once.
 *
 * A lease can expire while the work is still running — a blocked event loop, a
 * long SES call, a paused container — and then two workers hold the same job
 * believing they own it. The compare-and-swap below is what makes that
 * survivable: whichever one wins the UPDATE sends, and the other gets no row
 * back and drops the job.
 *
 *   Redis decides who tries.  Postgres decides who sends.
 *
 * ⚠ AND IT IS DELIBERATELY AT-LEAST-ONCE, NOT EXACTLY-ONCE. There is one window
 * this cannot close: the worker calls SES, SES accepts, and the process dies
 * before recording the result. The row says `sending`, the claim times out, and
 * a second worker cannot ask SES whether it already took that message — SES
 * offers no request-level idempotency key. So it sends again.
 *
 * That is the agreed trade: a message that never arrives is a support ticket, a
 * duplicate is a shrug. Two things narrow it. The window is one statement wide,
 * because the result is written immediately after the call returns. And the
 * retry reuses the SAME RFC 5322 Message-ID, derived from the row's id, so
 * receiving systems collapse the duplicate on their side.
 */

/**
 * How a message is addressed once it is in the database.
 *
 * ⚠ BOTH HALVES ARE REQUIRED, AND `createdAt` IS NOT DERIVABLE FROM `id`.
 * `core.messages` is partitioned by `created_at`, so its primary key is
 * `(id, created_at)` and every lookup needs the pair. The id is a UUIDv7 and
 * does carry a timestamp, but the column defaults to `now()` in the same
 * statement — the two are microseconds apart, not equal. The embedded one is
 * good enough to prune partitions with a range predicate and wrong for an
 * equality match, which is the one place it would silently return nothing.
 */
export interface MessageRef {
  id: string
  createdAt: Date
}

/** A row this worker now owns. */
export interface ClaimedMessage extends MessageRef {
  tenantId: string
  queue: "transactional" | "bulk"
  attempts: number
  fromAddress: string
  toAddresses: string[]
  ccAddresses: string[]
  bccAddresses: string[]
  replyTo: string[]
  subject: string
}

export interface ClaimOptions {
  /**
   * Identifies the worker holding the claim. Written to `claimed_by`, which is
   * how a stuck row is traced back to the process that abandoned it.
   */
  workerId: string
  /**
   * How long a row may sit in `sending` before another worker may take it.
   *
   * ⚠ IT MUST EXCEED groupmq's `jobTimeoutMs`, OR THE TWO FIGHT. Redis hands
   * the job to a second worker after its own timeout; if this interval were
   * shorter, that worker would also win the CAS and the duplicate would be
   * routine rather than exceptional. Longer, and the database refuses the
   * second worker until it is genuinely likely the first is gone.
   */
  staleAfter: string
}

/**
 * The compare-and-swap.
 *
 * Returns only the rows this worker actually won: the UPDATE ... RETURNING is
 * one statement, so the check and the take cannot be separated by another
 * transaction. Anything missing from the result belongs to somebody else and
 * must be dropped rather than retried — retrying is how a lost race turns into
 * a duplicate send.
 *
 * ⚠ IT ALSO RECLAIMS STALE `sending` ROWS, AND THAT IS NOT AN EXTRA FEATURE.
 * Without it a worker that dies mid-send strands its messages in `sending`
 * forever, and the failure is invisible: no error, no retry, mail simply never
 * arrives. `core.sweep_stuck_messages` finds those rows; this is what takes
 * them. The two predicates must stay in agreement.
 */
export function claimStatement(refs: readonly MessageRef[], opts: ClaimOptions): SQL {
  const rows = refs.map(
    (r) => sql`(${r.id}::uuid, ${r.createdAt.toISOString()}::timestamptz)`,
  )

  return sql`
    update core.messages m
       set status     = 'sending',
           attempts   = m.attempts + 1,
           claimed_by = ${opts.workerId},
           claimed_at = now()
      from (values ${sql.join(rows, sql`, `)}) as v (id, created_at)
     where m.id = v.id
       and m.created_at = v.created_at
       and (
             m.status = 'queued'
             or (m.status = 'sending' and m.claimed_at < now() - ${opts.staleAfter}::interval)
           )
    returning m.id, m.created_at, m.tenant_id, m.queue, m.attempts,
              m.from_address, m.to_addresses, m.cc_addresses, m.bcc_addresses,
              m.reply_to, m.subject
  `
}

/**
 * Records that SES accepted the message.
 *
 * ⚠ GUARDED ON `status = 'sending'` AND ON THE CLAIM. A worker whose lease
 * expired mid-send may still be alive and may still reach this line, by which
 * time another worker owns the row and may already have sent it. Writing
 * unconditionally would overwrite the second worker's `ses_message_id` with the
 * first's, and the event stream would then join to a message id we no longer
 * hold — a delivery that appears to belong to nothing.
 */
export function markSentStatement(
  ref: MessageRef,
  workerId: string,
  sesMessageId: string,
): SQL {
  return sql`
    update core.messages
       set status         = 'sent',
           sent_at        = now(),
           ses_message_id = ${sesMessageId},
           last_error     = null
     where id = ${ref.id}::uuid
       and created_at = ${ref.createdAt.toISOString()}::timestamptz
       and status = 'sending'
       and claimed_by = ${workerId}
    returning id
  `
}

/**
 * Records a failed attempt.
 *
 * `permanent` decides whether the row goes back for another try or stops here.
 * It is the caller's judgement rather than an attempt count, because the two
 * are different questions: a malformed address will never succeed no matter how
 * many attempts remain, and a 429 from SES will succeed on the next one.
 *
 * ⚠ A RETRYABLE FAILURE RETURNS THE ROW TO `queued`, NOT TO `sending`. Left in
 * `sending` it would depend on the stale-claim sweep to move again, which turns
 * a two-second retry into a several-minute one.
 */
export function markFailedStatement(
  ref: MessageRef,
  workerId: string,
  error: string,
  permanent: boolean,
): SQL {
  return sql`
    update core.messages
       set status     = ${permanent ? sql`'failed'` : sql`'queued'`},
           last_error = ${error.slice(0, 2000)},
           claimed_by = null,
           claimed_at = null
     where id = ${ref.id}::uuid
       and created_at = ${ref.createdAt.toISOString()}::timestamptz
       and status = 'sending'
       and claimed_by = ${workerId}
    returning id
  `
}
