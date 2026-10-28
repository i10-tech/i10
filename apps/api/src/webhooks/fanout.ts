import { and, eq, sql } from "drizzle-orm"
import type { WebhookEventName } from "@repo/contracts"
import type { withTenant } from "../db/client.js"
import { planAssignments, webhookDeliveries, webhookEndpoints } from "../db/core.js"
import { pollingRow } from "./kinds.js"
import { policyForPlan } from "./schedule.js"

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]

/** A delivery row written and owed an attempt, for the caller to queue. */
export interface FannedOut {
  id: string
  endpointId: string
  tenantId: string
  occurredAt: Date
}

/**
 * Writes one delivery per enabled endpoint of the workspace that subscribed to
 * `type`, for an event that is about the workspace rather than about an email
 * (the `webhook_endpoint.*` health events, #284, and the identity events,
 * #345). Returns what must be queued; a polling endpoint's row waits for its
 * poll and is not returned.
 *
 * ⚠ SEQUENCE NUMBERS ARE TAKEN IN THE SAME STATEMENT THAT SELECTS THE
 * ENDPOINTS, exactly as mail events do (webhooks/db.ts), so two events fanned
 * out at once never share a number or skip one.
 *
 * ⚠ MAIL FILTERS DO NOT APPLY. A domain or tag filter narrows email events;
 * these are not about any email, so an endpoint subscribed to them gets them.
 */
export async function fanOutToSubscribers(
  tx: Tx,
  input: {
    tenantId: string
    type: WebhookEventName
    data: Record<string, unknown>
    occurredAt: Date
    /** An endpoint the event is about, which is never sent it. */
    exceptEndpointId?: string
  },
): Promise<FannedOut[]> {
  const endpoints = await tx
    .update(webhookEndpoints)
    .set({ nextSequence: sql`${webhookEndpoints.nextSequence} + 1` })
    .where(
      and(
        eq(webhookEndpoints.enabled, true),
        input.exceptEndpointId
          ? sql`${webhookEndpoints.id} <> ${input.exceptEndpointId}`
          : undefined,
        sql`${webhookEndpoints.events} @> ARRAY[${input.type}]::core.webhook_event_type[]`,
      ),
    )
    .returning({
      id: webhookEndpoints.id,
      sequence: webhookEndpoints.nextSequence,
      kind: webhookEndpoints.kind,
    })
  if (endpoints.length === 0) return []

  // ⚠ THE PLAN IS READ HERE AND FROZEN ON EACH ROW, so the retry window is the
  // one in force when the event happened (webhooks/schedule.ts).
  const [assignment] = await tx
    .select({ planId: planAssignments.planId })
    .from(planAssignments)
    .where(eq(planAssignments.tenantId, input.tenantId))
    .limit(1)
  const rows = await tx
    .insert(webhookDeliveries)
    .values(
      endpoints.map((endpoint) => ({
        tenantId: input.tenantId,
        endpointId: endpoint.id,
        retryPolicy: policyForPlan(assignment?.planId),
        sequence: endpoint.sequence,
        eventType: input.type,
        occurredAt: input.occurredAt,
        payload: input.data as never,
        ...pollingRow(endpoint.kind),
      })),
    )
    .returning({ id: webhookDeliveries.id, endpointId: webhookDeliveries.endpointId })
  const sent = new Set(endpoints.filter((e) => e.kind !== "polling").map((e) => e.id))
  return rows
    .filter((r) => sent.has(r.endpointId))
    .map((r) => ({
      id: r.id,
      endpointId: r.endpointId,
      tenantId: input.tenantId,
      occurredAt: input.occurredAt,
    }))
}
