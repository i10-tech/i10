import type { Queue } from "groupmq"
import { eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { planAssignments, webhookDeliveries, webhookEndpoints } from "../db/core.js"
import { enqueueDelivery, type WebhookJob } from "../queue/webhook-queue.js"
import type { WebhookEventType } from "./events.js"
import { exampleData } from "./examples.js"
import { pollingRow } from "./kinds.js"
import { policyForPlan } from "./schedule.js"

/**
 * Sending a sample event to one endpoint (#281).
 *
 * ⚠ A REAL DELIVERY, NOT A SIMULATION. It is recorded, signed with the
 * endpoint's live keys, vetted for SSRF, retried and logged exactly like any
 * other - the only differences are `test: true` in the data, `test` as the
 * attempt's trigger, and no `sequence` (a test is not part of the endpoint's
 * stream, and numbering it would leave a gap the receiver waits on).
 */
export type TestResult =
  | { status: "queued"; deliveryId: string }
  | { status: "paused" }
  | { status: "not_found" }

export async function sendTestEvent(
  db: Database,
  queue: Queue<WebhookJob>,
  tenantId: string,
  endpointId: string,
  type: WebhookEventType,
): Promise<TestResult> {
  const recorded = await withTenant(db, tenantId, async (tx) => {
    const [endpoint] = await tx
      .select({
        id: webhookEndpoints.id,
        enabled: webhookEndpoints.enabled,
        kind: webhookEndpoints.kind,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId))
      .limit(1)
    if (!endpoint) return { status: "not_found" as const }
    if (!endpoint.enabled) return { status: "paused" as const }
    const [assignment] = await tx
      .select({ planId: planAssignments.planId })
      .from(planAssignments)
      .where(eq(planAssignments.tenantId, tenantId))
      .limit(1)
    // ⚠ A POLLING ENDPOINT'S TEST IS PART OF ITS STREAM (#301). Its cursor is
    // the sequence, so a test without one could never be polled; it takes the
    // next number like any event and waits for the poll.
    const polling = endpoint.kind === "polling"
    const sequence = polling
      ? (
          await tx
            .update(webhookEndpoints)
            .set({ nextSequence: sql`${webhookEndpoints.nextSequence} + 1` })
            .where(eq(webhookEndpoints.id, endpointId))
            .returning({ sequence: webhookEndpoints.nextSequence })
        )[0]!.sequence
      : null
    const now = new Date()
    const [row] = await tx
      .insert(webhookDeliveries)
      .values({
        tenantId,
        endpointId,
        eventType: type,
        occurredAt: now,
        payload: exampleData(type, now) as never,
        retryPolicy: policyForPlan(assignment?.planId),
        sequence,
        ...pollingRow(endpoint.kind),
      })
      .returning({ id: webhookDeliveries.id })
    return { status: "recorded" as const, id: row!.id, occurredAt: now, polling }
  })
  if (recorded.status !== "recorded") return recorded
  if (recorded.polling) return { status: "queued", deliveryId: recorded.id }

  // If this fails, the row is due now and the sweep sends it (as `scheduled`).
  await enqueueDelivery(
    queue,
    { deliveryId: recorded.id, endpointId, tenantId, trigger: "test" },
    { orderMs: recorded.occurredAt.getTime() },
  )
  return { status: "queued", deliveryId: recorded.id }
}
