import { and, eq, sql } from "drizzle-orm"
import type { Queue } from "groupmq"
import { withTenant, type Database } from "../db/client.js"
import {
  messageEvents,
  suppressions,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/core.js"
import { timestampFromUuidV7 } from "../ids.js"
import { enqueueDelivery, type WebhookJob } from "../queue/webhook-queue.js"
import type { DeliverDeps, DeliveryRecord } from "./deliver.js"
import { DISABLE_AFTER_FAILURES } from "./deliver.js"
import type { EventOps, WebhookEventType } from "./events.js"
import type { SecretBox } from "./signing.js"

/**
 * The webhook path, bound to Postgres and the delivery queue.
 *
 * ⚠ EVERY STATEMENT THAT TOUCHES A TENANT'S ROWS RUNS INSIDE `withTenant`. The
 * one exception is `ownerOf`, which cannot: it is the lookup that discovers
 * which tenant to set, and it is a `SECURITY DEFINER` function precisely so it
 * is the only cross-tenant read in this file — see migration 0009.
 */

type Row = Record<string, unknown>

/** Our public event names, mapped to the delivery log's own enum. */
const EVENT_TO_LOG: Record<WebhookEventType, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
}

/**
 * Slack around the id's embedded millisecond.
 *
 * The column defaults to `now()` in the same statement that mints the id, so
 * the two are microseconds apart rather than equal — but a partition is a
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

// ⚠ NO `secrets`. Nothing in the ingest path signs anything — only the
// delivery worker does — and this object lives for the life of the process, so
// taking the SecretBox here would pin the AES key in memory for a use that does
// not exist.
export function webhookEventOps(opts: Omit<WebhookDbOptions, "secrets">): EventOps {
  return {
    async ownerOf(messageId) {
      // ⚠ THE WINDOW COMES FROM THE ID ITSELF, WHICH IS THE ONLY REASON THIS IS
      // CHEAP. `core.messages` is partitioned by `created_at`, so a lookup by
      // bare id scans every partition — and this runs once per SES event, which
      // is several times per email sent. A UUIDv7 carries its own creation
      // millisecond, so the partition is derivable without asking.
      //
      // An id we cannot date — a v4 from a fixture, a future scheme — falls
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
        // transaction — and its row locks — open for fifty round trips.
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
        const endpoints = await tx
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.enabled, true),
              sql`${webhookEndpoints.events} @> ARRAY[${event.type}]::core.webhook_event_type[]`,
            ),
          )

        if (endpoints.length === 0) {
          return { status: "recorded" as const, deliveries: [] }
        }

        const deliveries = await tx
          .insert(webhookDeliveries)
          .values(
            endpoints.map((endpoint) => ({
              tenantId,
              endpointId: endpoint.id,
              eventType: event.type,
              occurredAt: event.occurredAt,
              messageId: event.messageId,
              // ⚠ THE PAYLOAD IS FROZEN HERE. Rebuilding it at attempt four
              // would describe the message as it is then, not as it was when
              // the event happened.
              payload: event.data as never,
            })),
          )
          .returning({
            id: webhookDeliveries.id,
            endpointId: webhookDeliveries.endpointId,
          })

        return {
          status: "recorded" as const,
          deliveries: deliveries.map((d) => ({
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
      // nothing depends on the order these are written — and serialising them
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
  opts: Omit<WebhookDbOptions, "queue">,
): Pick<DeliverDeps, "load" | "markDelivered" | "markFailed"> {
  return {
    async load(job: WebhookJob): Promise<DeliveryRecord | null> {
      return withTenant(opts.db, job.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: webhookDeliveries.id,
            endpointId: webhookDeliveries.endpointId,
            eventType: webhookDeliveries.eventType,
            payload: webhookDeliveries.payload,
            attempts: webhookDeliveries.attempts,
            occurredAt: webhookDeliveries.occurredAt,
            url: webhookEndpoints.url,
            secretCiphertext: webhookEndpoints.secretCiphertext,
            enabled: webhookEndpoints.enabled,
          })
          .from(webhookDeliveries)
          .innerJoin(
            webhookEndpoints,
            eq(webhookEndpoints.id, webhookDeliveries.endpointId),
          )
          .where(
            and(
              eq(webhookDeliveries.id, job.deliveryId),
              // ⚠ `pending` ONLY. A job re-enqueued by a sweep for a row another
              // worker has since delivered must find nothing rather than send
              // the customer a second copy.
              eq(webhookDeliveries.status, "pending"),
            ),
          )
          .limit(1)

        const row = rows[0]
        if (!row) return null

        // ⚠ A DISABLED ENDPOINT IS A TERMINAL ANSWER, NOT A SKIP. Returning null
        // and leaving the row `pending` would strand every delivery already
        // queued for an endpoint that has just been switched off — permanently,
        // because nothing sweeps them — and would make the pending count
        // useless as a measure of what is still being retried.
        if (!row.enabled) {
          await tx
            .update(webhookDeliveries)
            .set({ status: "failed", lastError: "endpoint disabled" })
            .where(eq(webhookDeliveries.id, row.id))
          return null
        }

        return {
          id: row.id,
          tenantId: job.tenantId,
          endpointId: row.endpointId,
          url: row.url,
          secret: opts.secrets.open(row.secretCiphertext),
          eventType: row.eventType as WebhookEventType,
          occurredAt: row.occurredAt,
          payload: (row.payload as Record<string, unknown>) ?? {},
          attempts: row.attempts,
        }
      })
    },

    async markDelivered(delivery, responseStatus) {
      await withTenant(opts.db, delivery.tenantId, async (tx) => {
        await tx
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            attempts: delivery.attempts + 1,
            responseStatus,
            deliveredAt: new Date(),
            lastError: null,
          })
          .where(eq(webhookDeliveries.id, delivery.id))

        // ⚠ ONE SUCCESS CLEARS THE COUNTER. Without this an endpoint that fails
        // nineteen times over a month and works in between would eventually be
        // switched off for being intermittently reachable, which is what every
        // endpoint on the internet is.
        await tx
          .update(webhookEndpoints)
          .set({ consecutiveFailures: 0, updatedAt: new Date() })
          .where(eq(webhookEndpoints.id, delivery.endpointId))
      })
    },

    async markFailed(delivery, outcome, final) {
      await withTenant(opts.db, delivery.tenantId, async (tx) => {
        await tx
          .update(webhookDeliveries)
          .set({
            // ⚠ STILL `pending` WHILE THERE IS BUDGET LEFT. Marking it failed on
            // the first attempt would make the row lie for the fifteen minutes
            // the retries take, and a sweep looking for stuck deliveries would
            // never see it.
            status: final ? "failed" : "pending",
            attempts: delivery.attempts + 1,
            lastError: outcome.reason.slice(0, 2000),
            ...(outcome.responseStatus
              ? { responseStatus: outcome.responseStatus }
              : {}),
          })
          .where(eq(webhookDeliveries.id, delivery.id))

        if (!final) return

        // ⚠ COUNTED ONLY WHEN THE WHOLE BUDGET IS GONE, so a five-attempt
        // recovery does not count as five failures against the endpoint.
        await tx
          .update(webhookEndpoints)
          .set({
            consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
            enabled: sql`case when ${webhookEndpoints.consecutiveFailures} + 1 >= ${DISABLE_AFTER_FAILURES} then false else ${webhookEndpoints.enabled} end`,
            disabledAt: sql`case when ${webhookEndpoints.consecutiveFailures} + 1 >= ${DISABLE_AFTER_FAILURES} then now() else ${webhookEndpoints.disabledAt} end`,
            updatedAt: new Date(),
          })
          .where(eq(webhookEndpoints.id, delivery.endpointId))
      })
    },
  }
}
