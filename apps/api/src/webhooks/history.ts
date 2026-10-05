import type { WebhookDelivery, WebhookDeliveryDetail } from "@repo/contracts"
import { asc, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { webhookAttempts, webhookDeliveries } from "../db/core.js"

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

export interface WebhookHistory {
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
}

export function webhookHistory(db: Database): WebhookHistory {
  return {
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
          .set({ payload: {}, payloadExpungedAt: new Date() })
          .where(eq(webhookDeliveries.id, deliveryId))
        return "expunged"
      })
    },
  }
}
