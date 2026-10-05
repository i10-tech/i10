import { and, eq, sql } from "drizzle-orm"
import type { Queue } from "groupmq"
import { withTenant, type Database } from "../db/client.js"
import {
  messageEvents,
  planAssignments,
  suppressions,
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/core.js"
import { timestampFromUuidV7 } from "../ids.js"
import { enqueueDelivery, type WebhookJob } from "../queue/webhook-queue.js"
import type { AttemptLog, DeliverDeps, DeliveryRecord } from "./deliver.js"
import { policyForPlan } from "./schedule.js"
import { liveRetiring } from "./keys.js"
import { onDelivered, onDisabled, onFailed } from "./health.js"
import { pollingRow } from "./kinds.js"
import {
  domainOf,
  type EventOps,
  type MailEventType,
  type WebhookEventType,
} from "./events.js"
import type { SecretBox } from "./signing.js"

/**
 * The webhook path, bound to Postgres and the delivery queue.
 *
 * ⚠ EVERY STATEMENT THAT TOUCHES A TENANT'S ROWS RUNS INSIDE `withTenant`. The
 * one exception is `ownerOf`, which cannot: it is the lookup that discovers
 * which tenant to set, and it is a `SECURITY DEFINER` function precisely so it
 * is the only cross-tenant read in this file - see migration 0009.
 */

type Row = Record<string, unknown>

/** Our public event names, mapped to the delivery log's own enum. */
const EVENT_TO_LOG: Record<MailEventType, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.unsubscribed": "unsubscribed",
}

/**
 * Slack around the id's embedded millisecond.
 *
 * The column defaults to `now()` in the same statement that mints the id, so
 * the two are microseconds apart rather than equal - but a partition is a
 * month wide, so a day of slack costs nothing and absorbs any clock skew
 * between the application and the database.
 */
const OWNER_WINDOW_MS = 24 * 60 * 60 * 1000
const EPOCH = new Date(0)
const FOREVER = new Date("2999-12-31T00:00:00Z")

export interface WebhookDbOptions {
  db: Database
  queue: Queue<WebhookJob>
  secrets: SecretBox
}

// ⚠ NO `secrets`. Nothing in the ingest path signs anything - only the
// delivery worker does - and this object lives for the life of the process, so
// taking the SecretBox here would pin the AES key in memory for a use that does
// not exist.
export function webhookEventOps(opts: Omit<WebhookDbOptions, "secrets">): EventOps {
  return {
    async ownerOf(messageId) {
      // ⚠ THE WINDOW COMES FROM THE ID ITSELF, WHICH IS THE ONLY REASON THIS IS
      // CHEAP. `core.messages` is partitioned by `created_at`, so a lookup by
      // bare id scans every partition - and this runs once per SES event, which
      // is several times per email sent. A UUIDv7 carries its own creation
      // millisecond, so the partition is derivable without asking.
      //
      // An id we cannot date - a v4 from a fixture, a future scheme - falls
      // back to an unbounded range rather than to a guess: slow beats a null
      // for a message that exists.
      const minted = timestampFromUuidV7(messageId)
      const from = minted ? new Date(minted.getTime() - OWNER_WINDOW_MS) : EPOCH
      const to = minted ? new Date(minted.getTime() + OWNER_WINDOW_MS) : FOREVER

      const rows = (await opts.db.execute(
        sql`select tenant_id, created_at
              from core.message_owner(
                ${messageId}::uuid,
                ${from.toISOString()}::timestamptz,
                ${to.toISOString()}::timestamptz
              )`,
      )) as unknown as Row[]

      const row = rows[0]
      if (!row) return null
      return {
        tenantId: String(row.tenant_id),
        createdAt: new Date(row.created_at as string | Date),
      }
    },

    async expiredOwnerOf(messageId) {
      const rows = (await opts.db.execute(
        sql`select core.expired_message_owner(${messageId}::uuid) as tenant_id`,
      )) as unknown as Row[]
      const id = rows[0]?.tenant_id
      return id ? String(id) : null
    },

    async suppressOnly({ tenantId, event }) {
      if (event.suppress.length === 0) return
      await withTenant(opts.db, tenantId, (tx) =>
        tx
          .insert(suppressions)
          .values(
            event.suppress.map((entry) => ({
              tenantId,
              address: entry.address,
              reason: entry.reason,
              messageId: event.messageId,
            })),
          )
          .onConflictDoNothing(),
      )
    },

    async record({ tenantId, event }) {
      return withTenant(opts.db, tenantId, async (tx) => {
        // ⚠ THE EVENT ROW IS THE DEDUPE, AND IT IS WRITTEN FIRST. SNS retries a
        // notification byte-for-byte, so the unique index on
        // (source_event_id, occurred_at) is what turns a redelivery into a
        // no-op. Written after the deliveries, a redelivery would queue the
        // customer's webhook a second time before discovering it was a repeat.
        const inserted = await tx
          .insert(messageEvents)
          .values({
            tenantId,
            messageId: event.messageId,
            occurredAt: event.occurredAt,
            type: EVENT_TO_LOG[event.type] as never,
            sourceEventId: event.sourceEventId,
            payload: event.raw as never,
          })
          .onConflictDoNothing({
            target: [messageEvents.sourceEventId, messageEvents.occurredAt],
          })
          .returning({ id: messageEvents.id })

        if (inserted.length === 0) return { status: "duplicate" as const }

        // ⚠ SUPPRESSION IN THE SAME TRANSACTION AS THE EVENT, SO THE TWO CANNOT
        // DISAGREE. A bounce recorded without its suppression means we keep
        // sending to a dead address and the evidence that we should not is
        // sitting in the same table.
        //
        // ⚠ ONE STATEMENT, NOT ONE PER RECIPIENT. A bounce can name every
        // recipient of a fifty-address send, and a loop of awaits holds the
        // transaction - and its row locks - open for fifty round trips.
        if (event.suppress.length > 0) {
          await tx
            .insert(suppressions)
            .values(
              event.suppress.map((entry) => ({
                tenantId,
                address: entry.address,
                reason: entry.reason,
                messageId: event.messageId,
              })),
            )
            // The first bounce is the one that explains it; a later complaint
            // for the same address must not overwrite that history.
            .onConflictDoNothing()
        }

        // ⚠ ONLY ENABLED ENDPOINTS, AND ONLY SUBSCRIBED ONES. A disabled
        // endpoint still exists so the customer can re-enable it; queueing for
        // it would mean a burst of stale events the moment they do.
        const eventDomain = domainOf(event.data.from)
        const eventTags = (event.data.tags as Record<string, string> | undefined) ?? {}

        // ⚠ SELECTED BY TAKING THE NEXT SEQUENCE NUMBER, IN ONE STATEMENT.
        // The update both finds the subscribed endpoints and hands each its
        // next number under the row lock, so two events recorded at once for
        // one endpoint can never share a number or skip one.
        const endpoints = await tx
          .update(webhookEndpoints)
          .set({ nextSequence: sql`${webhookEndpoints.nextSequence} + 1` })
          .where(
            and(
              eq(webhookEndpoints.enabled, true),
              sql`${webhookEndpoints.events} @> ARRAY[${event.type}]::core.webhook_event_type[]`,
              // ⚠ FILTERS NARROW, NEVER WIDEN: an endpoint with none set gets
              // everything it subscribed to, as before (#281). A domain filter
              // matches the sending domain; a tag filter needs every tag it
              // names, with the same value, on the message.
              sql`(${webhookEndpoints.filterDomains} is null or ${eventDomain}::text = any(${webhookEndpoints.filterDomains}))`,
              sql`(${webhookEndpoints.filterTags} is null or ${JSON.stringify(eventTags)}::jsonb @> ${webhookEndpoints.filterTags})`,
            ),
          )
          .returning({
            id: webhookEndpoints.id,
            sequence: webhookEndpoints.nextSequence,
            kind: webhookEndpoints.kind,
          })

        if (endpoints.length === 0) {
          return { status: "recorded" as const, deliveries: [] }
        }

        // ⚠ THE PLAN IS READ HERE AND FROZEN ON EACH ROW, so the retry window
        // is the one in force when the event happened (webhooks/schedule.ts).
        const [assignment] = await tx
          .select({ planId: planAssignments.planId })
          .from(planAssignments)
          .where(eq(planAssignments.tenantId, tenantId))
          .limit(1)
        const retryPolicy = policyForPlan(assignment?.planId)

        const deliveries = await tx
          .insert(webhookDeliveries)
          .values(
            endpoints.map((endpoint) => ({
              tenantId,
              endpointId: endpoint.id,
              retryPolicy,
              sequence: endpoint.sequence,
              eventType: event.type,
              occurredAt: event.occurredAt,
              messageId: event.messageId,
              // ⚠ THE PAYLOAD IS FROZEN HERE. Rebuilding it at attempt four
              // would describe the message as it is then, not as it was when
              // the event happened.
              payload: event.data as never,
              ...pollingRow(endpoint.kind),
            })),
          )
          .returning({
            id: webhookDeliveries.id,
            endpointId: webhookDeliveries.endpointId,
          })

        // Only what is sent goes to the queue; a polling endpoint's rows wait
        // for its poll (#301).
        const sent = new Set(
          endpoints.filter((e) => e.kind === "http").map((e) => e.id),
        )
        return {
          status: "recorded" as const,
          deliveries: deliveries
            .filter((d) => sent.has(d.endpointId))
            .map((d) => ({
              id: d.id,
              endpointId: d.endpointId,
              tenantId,
              occurredAt: event.occurredAt,
            })),
        }
      })
    },

    async enqueue(deliveries) {
      // ⚠ TOGETHER, BECAUSE EACH GOES TO A DIFFERENT ENDPOINT. groupmq orders
      // within a group and every delivery here belongs to a different one, so
      // nothing depends on the order these are written - and serialising them
      // puts N Redis round trips on the SNS ingest path, which SES retries if
      // it takes too long.
      await Promise.all(
        deliveries.map((delivery) =>
          enqueueDelivery(
            opts.queue,
            {
              deliveryId: delivery.id,
              endpointId: delivery.endpointId,
              tenantId: delivery.tenantId,
            },
            // ⚠ THE EVENT'S CLOCK, NOT NOW. See queue/webhook-queue.ts: two
            // events for one message arrive as concurrent SNS requests, and
            // ordering on arrival is how a customer sees `delivered` before
            // `sent`.
            { orderMs: delivery.occurredAt.getTime() },
          ),
        ),
      )
    },
  }
}

/**
 * The worker half: load a delivery, then record what happened to it.
 */
export function webhookDeliveryOps(
  opts: Omit<WebhookDbOptions, "queue"> & {
    /**
     * How long one attempt may hold its row. Longer than the delivery timeout
     * plus the bookkeeping around it; the sweep never touches a held row.
     */
    leaseSeconds?: number
    /** Nothing succeeding for this long marks an endpoint failing (#284). */
    failingAfterSeconds?: number
    /**
     * Told each health change once its transaction has committed, to fan it
     * out as `webhook_endpoint.*` webhooks. Must not throw.
     */
    onHealthChange?: (tenantId: string, eventId: string) => void
  },
): Pick<DeliverDeps, "load" | "markDelivered" | "markFailed"> {
  return {
    async load(job: WebhookJob): Promise<DeliveryRecord | null> {
      return withTenant(opts.db, job.tenantId, async (tx) => {
        /*
         * ⚠ CLAIMED, NOT READ. The row is leased to this worker for as long
         * as one attempt can take, and only if nobody else holds it. That is
         * what lets the sweep re-queue a row the queue may still hold: both
         * jobs can arrive, and the second finds the lease taken and stops.
         * A worker that crashes mid-attempt leaves a lease that simply
         * expires, and the sweep picks the row up after it.
         *
         * ⚠ `pending` ONLY. A job for a row another worker has since delivered
         * must find nothing rather than send the customer a second copy.
         */
        const claimed = await tx
          .update(webhookDeliveries)
          .set({
            claimedUntil: sql`now() + ${`${opts.leaseSeconds ?? 120} seconds`}::interval`,
          })
          .where(
            and(
              eq(webhookDeliveries.id, job.deliveryId),
              eq(webhookDeliveries.status, "pending"),
              sql`(${webhookDeliveries.claimedUntil} is null or ${webhookDeliveries.claimedUntil} < now())`,
              // ⚠ NOT BEFORE IT IS OWED. A second job for the same row - the
              // sweep's, beside a retry the queue still holds - must not
              // attempt early. The slack is not generosity: groupmq's
              // retry.lua floors Redis's clock to the second, so its own
              // retries fire up to a second early (measured 2026-10-05), and
              // refusing those would skip the retry the queue was holding.
              sql`(${webhookDeliveries.nextAttemptAt} is null or ${webhookDeliveries.nextAttemptAt} <= now() + interval '2 seconds')`,
            ),
          )
          .returning({ id: webhookDeliveries.id })
        if (claimed.length === 0) return null

        const rows = await tx
          .select({
            id: webhookDeliveries.id,
            endpointId: webhookDeliveries.endpointId,
            eventType: webhookDeliveries.eventType,
            payload: webhookDeliveries.payload,
            attempts: webhookDeliveries.attempts,
            occurredAt: webhookDeliveries.occurredAt,
            retryPolicy: webhookDeliveries.retryPolicy,
            sequence: webhookDeliveries.sequence,
            firstFailedAt: webhookDeliveries.firstFailedAt,
            lane: webhookDeliveries.lane,
            url: webhookEndpoints.url,
            rateLimit: webhookEndpoints.rateLimit,
            headers: webhookEndpoints.headers,
            secretCiphertext: webhookEndpoints.secretCiphertext,
            signatureScheme: webhookEndpoints.signatureScheme,
            retiringSecrets: webhookEndpoints.retiringSecrets,
            enabled: webhookEndpoints.enabled,
          })
          .from(webhookDeliveries)
          .innerJoin(
            webhookEndpoints,
            eq(webhookEndpoints.id, webhookDeliveries.endpointId),
          )
          .where(eq(webhookDeliveries.id, job.deliveryId))
          .limit(1)

        const row = rows[0]
        if (!row) return null

        // ⚠ A DISABLED ENDPOINT IS A TERMINAL ANSWER, NOT A SKIP. Returning null
        // and leaving the row `pending` would strand every delivery already
        // queued for an endpoint that has just been switched off - and the
        // sweep would keep finding it, due and unclaimed, for ever.
        if (!row.enabled) {
          await tx
            .update(webhookDeliveries)
            .set({
              status: "failed",
              lastError: "endpoint disabled",
              nextAttemptAt: null,
              claimedUntil: null,
            })
            .where(eq(webhookDeliveries.id, row.id))
          return null
        }

        // ⚠ A POLLING ENDPOINT IS NEVER SENT TO (#301). Its rows are written
        // with no attempt owed, so this is a job that should not exist - a
        // replay or a test queued by mistake. The row goes back to waiting for
        // its poll, untouched, rather than failing or going anywhere.
        if (row.url === null) {
          await tx
            .update(webhookDeliveries)
            .set({ nextAttemptAt: null, claimedUntil: null })
            .where(eq(webhookDeliveries.id, row.id))
          return null
        }

        return {
          id: row.id,
          tenantId: job.tenantId,
          endpointId: row.endpointId,
          url: row.url,
          // ⚠ THE CURRENT KEY FIRST, THEN EVERY RETIRING KEY STILL IN ITS
          // GRACE PERIOD. Expiry is judged now, at signing, so a key stops
          // signing at the moment the customer chose even if nothing has
          // touched the row since.
          keys: [
            {
              scheme: row.signatureScheme,
              secret: opts.secrets.open(row.secretCiphertext),
            },
            ...liveRetiring(row.retiringSecrets, new Date()).map((r) => ({
              scheme: r.scheme,
              secret: opts.secrets.open(r.ciphertext),
            })),
          ],
          eventType: row.eventType as WebhookEventType,
          occurredAt: row.occurredAt,
          payload: (row.payload as Record<string, unknown>) ?? {},
          attempts: row.attempts,
          retryPolicy: row.retryPolicy,
          sequence: row.sequence,
          firstFailedAt: row.firstFailedAt,
          lane: row.lane,
          rateLimit: row.rateLimit,
          headers: row.headers ?? {},
        }
      })
    },

    async markDelivered(delivery, responseStatus, attempt) {
      const changed = await withTenant(opts.db, delivery.tenantId, async (tx) => {
        await recordAttempt(tx, delivery, attempt)
        await tx
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            attempts: delivery.attempts + 1,
            responseStatus,
            deliveredAt: new Date(),
            lastError: null,
            nextAttemptAt: null,
            claimedUntil: null,
          })
          .where(eq(webhookDeliveries.id, delivery.id))

        // ⚠ ONE SUCCESS ENDS THE FAILING RUN. An endpoint that works now and
        // then is reachable, which is all disabling asks; only a stretch with
        // no success at all counts against it. If it had been failing, this
        // is also the recovery its owner is told about (#284).
        return onDelivered(tx, delivery.tenantId, delivery.endpointId)
      })
      if (changed) opts.onHealthChange?.(delivery.tenantId, changed)
    },

    async markFailed(delivery, outcome, decision, attempt) {
      const final = decision.nextAttemptAt === null
      const changed = await withTenant(opts.db, delivery.tenantId, async (tx) => {
        const changes: string[] = []
        await recordAttempt(tx, delivery, attempt)
        await tx
          .update(webhookDeliveries)
          .set({
            // ⚠ STILL `pending` WHILE THERE IS BUDGET LEFT. Marking it failed on
            // the first attempt would make the row lie for as long as the
            // retries take, and the sweep would never see it.
            status: final ? "failed" : "pending",
            attempts: delivery.attempts + 1,
            lastError: outcome.reason.slice(0, 2000),
            // ⚠ THE NEXT ATTEMPT IS WRITTEN HERE, IN THE SAME STATEMENT AS THE
            // FAILURE, so a retry exists in Postgres before it exists in Redis.
            // If queueing it then fails, the sweep finds it due.
            nextAttemptAt: decision.nextAttemptAt,
            claimedUntil: null,
            firstFailedAt: sql`coalesce(${webhookDeliveries.firstFailedAt}, now())`,
            // ⚠ MOVED ASIDE IN THE SAME STATEMENT THAT RECORDS THE FAILURE, so
            // the sweep re-queues it onto the lane it now belongs to.
            lane: decision.lane,
            ...(outcome.responseStatus
              ? { responseStatus: outcome.responseStatus }
              : {}),
          })
          .where(eq(webhookDeliveries.id, delivery.id))

        // The failing run starts at the first failure after a success. A
        // replay that fails is not evidence about the endpoint; it does not
        // start one.
        if (decision.disable.kind !== "none")
          await tx
            .update(webhookEndpoints)
            .set({
              failingSince: sql`coalesce(${webhookEndpoints.failingSince}, now())`,
            })
            .where(eq(webhookEndpoints.id, delivery.endpointId))

        // ⚠ GUARDED ON `enabled`, SO A SECOND 410 IN FLIGHT DOES NOT REPORT A
        // SECOND DISABLE. The row comes back only from the update that
        // actually switched it off.
        const disabled = {
          enabled: false,
          health: "disabled" as const,
          healthChangedAt: new Date(),
          disabledAt: new Date(),
          updatedAt: new Date(),
        }
        const switchedOff = async (
          row: { url: string | null; failingSince: Date | null } | undefined,
          reason: string,
        ) => {
          if (row)
            changes.push(
              await onDisabled(tx, {
                tenantId: delivery.tenantId,
                endpointId: delivery.endpointId,
                url: row.url,
                reason,
                failingSince: row.failingSince,
              }),
            )
        }

        if (decision.disable.kind === "gone") {
          const [row] = await tx
            .update(webhookEndpoints)
            .set({ ...disabled, disabledReason: decision.disable.reason })
            .where(
              and(
                eq(webhookEndpoints.id, delivery.endpointId),
                eq(webhookEndpoints.enabled, true),
              ),
            )
            .returning({
              url: webhookEndpoints.url,
              failingSince: webhookEndpoints.failingSince,
            })
          await switchedOff(row, decision.disable.reason)
          return changes
        }

        if (decision.disable.kind !== "none") {
          const failing = await onFailed(
            tx,
            delivery.tenantId,
            delivery.endpointId,
            outcome.reason,
            opts.failingAfterSeconds,
          )
          if (failing) changes.push(failing)
        }

        if (!final || decision.disable.kind === "none") return changes

        // ⚠ JUDGED WHEN A DELIVERY RUNS OUT, AGAINST TIME, NOT A COUNT. Only an
        // endpoint with no success at all for the plan's stretch is switched
        // off; the reason is kept so the customer is told why.
        const days = Math.round(decision.disable.seconds / 86_400)
        const reason = `No successful delivery for ${days} day${days === 1 ? "" : "s"}.`
        const [row] = await tx
          .update(webhookEndpoints)
          .set({ ...disabled, disabledReason: reason })
          .where(
            and(
              eq(webhookEndpoints.id, delivery.endpointId),
              eq(webhookEndpoints.enabled, true),
              sql`${webhookEndpoints.failingSince} <= now() - ${`${decision.disable.seconds} seconds`}::interval`,
            ),
          )
          .returning({
            url: webhookEndpoints.url,
            failingSince: webhookEndpoints.failingSince,
          })
        await switchedOff(row, reason)
        return changes
      })
      // ⚠ AFTER THE COMMIT, NEVER INSIDE IT. See `webhookHealthEvents` in
      // core.ts: fanning out locks other endpoints' rows.
      for (const id of changed) opts.onHealthChange?.(delivery.tenantId, id)
    },
  }
}

/**
 * One row in the attempt log, in the same transaction as the outcome it
 * explains, so the log and the delivery can never disagree.
 */
async function recordAttempt(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  delivery: DeliveryRecord,
  attempt: AttemptLog,
): Promise<void> {
  await tx.insert(webhookAttempts).values({
    tenantId: delivery.tenantId,
    deliveryId: delivery.id,
    endpointId: delivery.endpointId,
    attempt: attempt.attempt,
    trigger: attempt.trigger,
    lane: attempt.lane,
    url: attempt.url,
    requestHeaders: attempt.requestHeaders,
    responseStatus: attempt.responseStatus ?? null,
    responseHeaders: attempt.responseHeaders ?? null,
    // ⚠ NUL IS THE ONE CHARACTER POSTGRES TEXT REFUSES, and a receiver's
    // body is arbitrary bytes. Dropping it beats failing the whole outcome.
    responseBody: attempt.responseBody?.replaceAll("\u0000", "") ?? null,
    durationMs: attempt.durationMs,
    errorKind: attempt.errorKind ?? null,
    error: attempt.error ?? null,
  })
}

/** A delivery the sweep found owed and unattended. */
export interface DueDelivery {
  lane: "ordered" | "retry"
  id: string
  tenantId: string
  endpointId: string
  occurredAt: Date
  attempts: number
  nextAttemptAt: Date
}

/**
 * Deliveries due for longer than `graceSeconds` that no worker holds, across
 * every tenant, through the one SECURITY DEFINER function written for it
 * (migration 0104). See engine.ts for what the sweep does with them.
 */
export async function dueDeliveries(
  db: Database,
  graceSeconds: number,
  limit: number,
): Promise<DueDelivery[]> {
  const rows = (await db.execute(sql`
    select id::text, tenant_id::text, endpoint_id::text, occurred_at, attempts, next_attempt_at, lane
      from core.webhook_deliveries_due(${`${graceSeconds} seconds`}::interval, ${limit}::int)
  `)) as unknown as Array<{
    id: string
    tenant_id: string
    endpoint_id: string
    occurred_at: string | Date
    attempts: number
    next_attempt_at: string | Date
    lane: "ordered" | "retry"
  }>
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    endpointId: r.endpoint_id,
    occurredAt: new Date(r.occurred_at),
    attempts: r.attempts,
    nextAttemptAt: new Date(r.next_attempt_at),
    lane: r.lane,
  }))
}
