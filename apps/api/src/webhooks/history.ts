import type {
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookHealthEvent,
} from "@repo/contracts"
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { webhookAttempts, webhookDeliveries } from "../db/core.js"
import { listHealthEvents } from "./health.js"
import { pollEndpoint, type PollResult } from "./poll.js"

/**
 * Reading a delivery's history, and expunging what it carried (#280).
 *
 * ⚠ EVERY READ HERE RUNS UNDER THE TENANT'S ROW LEVEL SECURITY. Another
 * workspace's delivery is not "forbidden", it does not exist - so a lookup by
 * somebody else's id answers exactly like a lookup by a made-up one.
 */

type DeliveryRow = typeof webhookDeliveries.$inferSelect

export const presentDelivery = (d: DeliveryRow): WebhookDelivery => ({
  object: "webhook_delivery",
  id: d.id,
  endpoint_id: d.endpointId,
  event_type: d.eventType,
  status: d.status,
  attempts: d.attempts,
  sequence: d.sequence,
  next_attempt_at:
    d.status === "pending" ? (d.nextAttemptAt?.toISOString() ?? null) : null,
  response_status: d.responseStatus,
  last_error: d.lastError,
  occurred_at: d.occurredAt.toISOString(),
  delivered_at: d.deliveredAt?.toISOString() ?? null,
  created_at: d.createdAt.toISOString(),
})

export type ExpungeResult = "expunged" | "pending" | "not_found"

export interface DeliveryFilter {
  endpointId?: string
  status?: "pending" | "delivered" | "failed"
  eventType?: string
  /** Created at or after. */
  after?: Date
  /** Created before. */
  before?: Date
  cursor?: string
  limit?: number
}

/**
 * ⚠ THE CURSOR CARRIES POSTGRES'S OWN TEXT FOR THE TIMESTAMP, NOT A JS DATE.
 * A Date keeps milliseconds and Postgres keeps microseconds, so a cursor
 * built from a Date skips or repeats rows created in the same millisecond -
 * which a burst of events does. The same rule as console/queries.ts.
 */
const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString("base64url")
const decodeCursor = (c: string): { at: string; id: string } | null => {
  try {
    const [at, id] = JSON.parse(Buffer.from(c, "base64url").toString()) as [
      string,
      string,
    ]
    // A malformed timestamp would be bound safely and still fail the cast in
    // Postgres; refuse it here so an edited cursor is ignored, not a 500.
    return typeof at === "string" &&
      !Number.isNaN(Date.parse(at)) &&
      typeof id === "string" &&
      /^[0-9a-f-]{36}$/.test(id)
      ? { at, id }
      : null
  } catch {
    return null
  }
}

export interface WebhookHistory {
  /** Newest first, keyset-paginated. */
  list: (
    tenantId: string,
    filter: DeliveryFilter,
  ) => Promise<{ data: WebhookDelivery[]; next_cursor: string | null }>
  get: (tenantId: string, deliveryId: string) => Promise<WebhookDeliveryDetail | null>
  /**
   * Empties a finished delivery's payload, keeping the row and its attempts.
   *
   * ⚠ ONLY ONCE IT IS FINISHED. A pending delivery still has attempts to make,
   * and expunging it would send the customer an empty event - a delivery that
   * succeeds and tells them nothing. They wait for it to finish, or delete
   * the endpoint.
   */
  expunge: (tenantId: string, deliveryId: string) => Promise<ExpungeResult>
  /** The next events for a polling endpoint, acknowledging up to `cursor` (#301). */
  poll: (
    tenantId: string,
    endpointId: string,
    input: { cursor?: number; limit?: number },
  ) => Promise<PollResult>
  /** Every change in an endpoint's health (#284), newest first. */
  health: (
    tenantId: string,
    filter: { endpointId?: string; cursor?: string; limit?: number },
  ) => Promise<{ data: WebhookHealthEvent[]; next_cursor: string | null }>
}

export function webhookHistory(
  db: Database,
  opts: {
    /**
     * Told a health change a poll caused (a quiet poller recovering), after
     * it commits, to fan it out at once rather than at the tick's backlog
     * sweep. Must not throw.
     */
    onHealthChange?: (tenantId: string, eventId: string) => void
  } = {},
): WebhookHistory {
  return {
    async list(tenantId, filter) {
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100)
      const cursor = filter.cursor ? decodeCursor(filter.cursor) : null
      return withTenant(db, tenantId, async (tx) => {
        const where: SQL[] = []
        if (filter.endpointId)
          where.push(eq(webhookDeliveries.endpointId, filter.endpointId))
        if (filter.status) where.push(eq(webhookDeliveries.status, filter.status))
        // As text: an unknown event name matches nothing rather than failing a cast.
        if (filter.eventType)
          where.push(sql`${webhookDeliveries.eventType}::text = ${filter.eventType}`)
        if (filter.after)
          where.push(
            sql`${webhookDeliveries.createdAt} >= ${filter.after.toISOString()}::timestamptz`,
          )
        if (filter.before)
          where.push(
            sql`${webhookDeliveries.createdAt} < ${filter.before.toISOString()}::timestamptz`,
          )
        if (cursor) {
          where.push(
            sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
          )
        }
        const rows = await tx
          .select({
            d: webhookDeliveries,
            at: sql<string>`${webhookDeliveries.createdAt}::text`,
          })
          .from(webhookDeliveries)
          .where(where.length ? and(...where) : undefined)
          .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
          .limit(limit + 1)
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        return {
          data: page.map((r) => presentDelivery(r.d)),
          next_cursor:
            rows.length > limit && last ? encodeCursor(last.at, last.d.id) : null,
        }
      })
    },

    async get(tenantId, deliveryId) {
      return withTenant(db, tenantId, async (tx) => {
        const [d] = await tx
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId))
          .limit(1)
        if (!d) return null
        const attempts = await tx
          .select()
          .from(webhookAttempts)
          .where(eq(webhookAttempts.deliveryId, deliveryId))
          .orderBy(asc(webhookAttempts.createdAt), asc(webhookAttempts.id))
        return {
          ...presentDelivery(d),
          payload: (d.payload as Record<string, unknown>) ?? {},
          payload_expunged_at: d.payloadExpungedAt?.toISOString() ?? null,
          transformed: d.transformed ?? null,
          attempt_log: attempts.map((a) => ({
            object: "webhook_attempt" as const,
            id: a.id,
            attempt: a.attempt,
            trigger: a.trigger,
            lane: a.lane,
            url: a.url,
            request_headers: a.requestHeaders,
            response_status: a.responseStatus,
            response_headers: a.responseHeaders,
            response_body: a.responseBody,
            duration_ms: a.durationMs,
            error_kind: a.errorKind,
            error: a.error,
            created_at: a.createdAt.toISOString(),
          })),
        }
      })
    },

    async expunge(tenantId, deliveryId) {
      return withTenant(db, tenantId, async (tx) => {
        const [d] = await tx
          .select({ status: webhookDeliveries.status })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId))
          .limit(1)
        if (!d) return "not_found"
        if (d.status === "pending") return "pending"
        await tx
          .update(webhookDeliveries)
          // ⚠ THE TRANSFORMED BODY TOO (#302). It is the same data in another
          // shape, and expunging one copy of it would be a promise half kept.
          .set({ payload: {}, transformed: null, payloadExpungedAt: new Date() })
          .where(eq(webhookDeliveries.id, deliveryId))
        return "expunged"
      })
    },

    async poll(tenantId, endpointId, input) {
      const result = await pollEndpoint(db, tenantId, endpointId, input)
      if (result.status === "ok" && result.healthChange)
        opts.onHealthChange?.(tenantId, result.healthChange)
      return result
    },

    health: (tenantId, filter) =>
      listHealthEvents(db, tenantId, {
        ...filter,
        limit: Math.min(Math.max(filter.limit ?? 50, 1), 100),
      }),
  }
}
