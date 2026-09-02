import { sql, type SQL } from "drizzle-orm"

/**
 * The second leg: does SES agree with our books?
 *
 * ⚠ THE THREE PARTIES MEET AT `core.messages`, AND THEY MEET NOWHERE ELSE.
 *
 *   SES ──▶ core.messages ──▶ Autumn ──▶ Polar
 *            (the hub)
 *
 * That shape is the whole point. SES discrepancies are repaired INTO the
 * messages table, and the Autumn reconciler then bills them on its next run
 * because they are simply `sent` rows it has not seen yet. Nothing here talks
 * to Autumn, and a message SES sent that we never recorded needs no special
 * billing path — it becomes an ordinary row and the existing machinery bills it.
 *
 * Repairing SES → Autumn directly would give the same number two writers, and
 * the two would disagree the first time one of them was retried.
 *
 * ⚠ POLAR IS A PLACE OF RECORD, NOT A PARTY TO THIS. Customers exist there so
 * the dashboard and its features work, and Autumn puts them there. It is
 * downstream of a number that is already agreed, so reconciling against it
 * would be checking Autumn's arithmetic rather than our own.
 *
 * ⚠ THE LEFT-HAND SIDE IS OUR EVENT LOG, WHICH IS A PUSH FEED AND THEREFORE
 * NOT INDEPENDENT EVIDENCE. `core.message_events` exists only because SES
 * publishes to a configuration set destination and our webhook received it. So
 * these three queries can find a message SES sent that we mis-recorded — but
 * they cannot find one SES sent that we never heard about at all, because the
 * absence of an event is exactly what a broken webhook also looks like.
 *
 * ⚠ SES CAN BE ASKED DIRECTLY, AND THAT IS THE MISSING FOURTH CHECK. There is
 * no synchronous "list messages" call, which is what made this look impossible
 * at first — but `CreateExportJob` with a `MessageInsightsDataSource` takes a
 * `StartDate` and `EndDate` and writes the individual messages to S3, and
 * `GetMessageInsights` looks one up by SES MessageId and returns its
 * `EmailTags` — which carry `i10_message_id`, so SES hands our own id back.
 *
 * That is a genuine second source of truth, independent of whether our webhook
 * ever ran, and it is what would close the orphan case properly. Not built yet,
 * and it has a prerequisite worth confirming in the console FIRST: Message
 * Insights is a Virtual Deliverability Manager feature, so with VDM disabled an
 * export job plausibly returns nothing — and it would return nothing the same
 * way a clean account does, which is the worst possible failure for a
 * reconciler. Neither the VDM dependency nor the retention window is stated in
 * the API reference; both need checking against the live account rather than
 * assuming.
 */

/**
 * ⚠ EVENTS ARRIVE LATE, AND WITHOUT THIS EVERY RUN INVENTS FINDINGS.
 *
 * SES publishes through SNS or EventBridge with its own retry schedule. A
 * message sent forty seconds ago legitimately has no `sent` event yet, so
 * comparing right up to `now()` reports every in-flight message as missing.
 * Nothing after this boundary is examined at all.
 *
 * Half an hour is comfortably more than SES's normal event latency. It is NOT
 * shorter than the reconciliation interval, and does not need to be: the job
 * runs every thirty to sixty minutes over a WINDOW rather than over "everything
 * since the last run", so a message skipped for being too recent is simply
 * picked up by the following run. What the grace must never be is shorter than
 * SES's latency, which is the setting that manufactures findings.
 */
export const EVENT_GRACE = "30 minutes"

/**
 * Messages SES accepted that our books do not count as sent.
 *
 * ⚠ THIS IS THE ONE THAT COSTS MONEY, AND IT IS THE EXPECTED OUTCOME OF THE
 * AT-LEAST-ONCE DESIGN RATHER THAN A BUG. The worker calls SES, SES accepts,
 * and the process dies before writing the result — the row stays `sending` and
 * is never billed, while the customer's mail was delivered. The claim in
 * db/claim.ts names that window and says it cannot be closed; this is what
 * finds what fell into it.
 *
 * The join is on our own id, which reaches SES as a `MessageTag` and comes back
 * on every event. `ses_message_id` is what the repair writes, so a row that
 * already has one has already been reconciled.
 */
export function sesSentButUnbilledStatement(limit: number): SQL {
  return sql`
    select m.id::text        as message_id,
           m.created_at      as created_at,
           m.tenant_id::text as tenant_id,
           m.status::text    as status,
           e.occurred_at     as ses_sent_at,
           e.payload ->> 'sesMessageId' as ses_message_id
      from core.message_events e
      join core.messages m
        on m.id = e.message_id
     where e.type = 'sent'
       and e.occurred_at < now() - ${EVENT_GRACE}::interval
       and m.status <> 'sent'
     order by e.occurred_at
     limit ${limit}
  `
}

/**
 * The repair.
 *
 * ⚠ IT MUST NOT OVERWRITE A ROW THAT IS ALREADY `sent`. Two reconcilers, or one
 * retried, would otherwise rewrite `sent_at` and move the message into a
 * different billing bucket — turning a repair into a double-count in the Autumn
 * reconciler that reads this table next.
 *
 * ⚠ AND `sent_at` COMES FROM SES'S EVENT, NOT FROM `now()`. The Autumn
 * reconciler buckets on `sent_at`; stamping the repair time would file a
 * message in the day it was noticed rather than the day it was sent, and every
 * boundary would then disagree with SES's own record of the same message.
 */
export function repairFromSesStatement(
  messageId: string,
  createdAt: Date,
  sesSentAt: Date,
  sesMessageId: string | null,
): SQL {
  return sql`
    update core.messages
       set status         = 'sent',
           sent_at        = ${sesSentAt.toISOString()}::timestamptz,
           ses_message_id = coalesce(ses_message_id, ${sesMessageId}),
           last_error     = null,
           claimed_by     = null,
           claimed_at     = null
     where id = ${messageId}::uuid
       and created_at = ${createdAt.toISOString()}::timestamptz
       and status <> 'sent'
    returning id
  `
}

/**
 * Rows we call `sent` that SES has never confirmed.
 *
 * The opposite direction, and it is a correctness question rather than a
 * billing one — we are billing for these, so being wrong means over-charging.
 *
 * ⚠ IT IS REPORTED, NEVER REPAIRED. There are three explanations and they need
 * different answers: the event destination is misconfigured and no events are
 * arriving at all; SES accepted the message and dropped it; or the worker wrote
 * `sent` for a call that actually failed. Automatically un-sending them would
 * hide the first, which is by far the most likely and the most serious, because
 * it silently disables the entire left-hand side of this file.
 */
export function billedButUnconfirmedStatement(from: Date, limit: number): SQL {
  return sql`
    select m.id::text        as message_id,
           m.created_at      as created_at,
           m.tenant_id::text as tenant_id,
           m.sent_at         as sent_at
      from core.messages m
     where m.status = 'sent'
       and m.sent_at >= ${from.toISOString()}::timestamptz
       and m.sent_at <  now() - ${EVENT_GRACE}::interval
       and not exists (
             select 1
               from core.message_events e
              where e.message_id = m.id
                and e.type = 'sent'
           )
     order by m.sent_at
     limit ${limit}
  `
}

/**
 * Events naming a message that does not exist in our books at all.
 *
 * ⚠ THE ALARMING ONE, AND IT IS NEVER AUTO-CREATED. A row cannot be invented
 * from an event: the event carries no sender, no recipients, no body and no api
 * key, so anything written would be a fabricated billing record. It means
 * either something sent mail outside this pipeline — which is a security
 * finding, not an accounting one — or a message row was lost, which is a
 * database problem. Both want a human.
 *
 * `message_events` has no foreign key to `messages` by design, so this is
 * possible rather than impossible, and that is the trade the missing FK bought:
 * an event arriving before or after its row is recorded rather than rejected.
 */
export function orphanEventsStatement(from: Date, limit: number): SQL {
  return sql`
    select e.message_id::text as message_id,
           e.tenant_id::text  as tenant_id,
           e.occurred_at      as occurred_at
      from core.message_events e
     where e.type = 'sent'
       and e.occurred_at >= ${from.toISOString()}::timestamptz
       and e.occurred_at <  now() - ${EVENT_GRACE}::interval
       and not exists (
             select 1 from core.messages m where m.id = e.message_id
           )
     order by e.occurred_at
     limit ${limit}
  `
}

export interface SesFinding {
  messageId: string
  tenantId: string
}

export interface SesReconcileReport {
  /** SES sent them, we did not bill them. Repaired, then billed by Autumn. */
  unbilled: SesFinding[]
  /** We billed them, SES never confirmed. Reported only. */
  unconfirmed: SesFinding[]
  /** SES sent something we have no row for. Reported only, loudly. */
  orphaned: SesFinding[]
}

/**
 * Whether a run is worth waking somebody for.
 *
 * ⚠ `unbilled` ALONE IS ROUTINE. The at-least-once design guarantees a trickle
 * of them, and the repair is the system working as intended — paging on it
 * would train everyone to ignore this job.
 *
 * The other two are not routine. `orphaned` means mail left the account without
 * a record. A large `unconfirmed` count means the event destination has
 * probably stopped delivering, which quietly disables the `unbilled` detection
 * as well — so the failure hides the failure, and that is worth an alert on its
 * own.
 */
export function needsAttention(
  report: SesReconcileReport,
  unconfirmedThreshold = 50,
): boolean {
  return report.orphaned.length > 0 || report.unconfirmed.length >= unconfirmedThreshold
}
