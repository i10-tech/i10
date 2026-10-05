import type { WebhookPoll } from "@repo/contracts"
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { webhookDeliveries, webhookEndpoints } from "../db/core.js"
import type { WebhookEventType } from "./events.js"
import { FAILING_AFTER_SECONDS, onDelivered, onDisabled, onFailed } from "./health.js"
import { RULES, type RetryPolicy, type RetryRules } from "./schedule.js"

/**
 * Polling endpoints (#301): the customer pulls their events instead of
 * exposing a URL. Svix's hosted product calls these pollers.
 *
 * ⚠ THE CURSOR IS THE SEQUENCE. Every event recorded for an endpoint already
 * takes the next number in its stream (#277), so "everything after n" is the
 * whole protocol: no separate queue, no second copy of the event. Passing a
 * cursor back acknowledges everything up to it - those deliveries become
 * `delivered`, and the history, stats and health read them like any other.
 *
 * ⚠ AND AN OLDER CURSOR READS AGAIN. Nothing is consumed by being read; a
 * receiver that lost its place, or wants a replay, polls from where it wants.
 * What retention has expired is gone, exactly as for an HTTP endpoint.
 */

export const MAX_POLL_LIMIT = 250

export type PollResult =
  | ({ status: "ok" } & WebhookPoll & { healthChange: string | null })
  | { status: "not_found" }
  | { status: "not_polling" }
  | { status: "paused" }
  | { status: "rejected"; reason: string }

export async function pollEndpoint(
  db: Database,
  tenantId: string,
  endpointId: string,
  input: { cursor?: number; limit?: number },
): Promise<PollResult> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), MAX_POLL_LIMIT)
  return withTenant(db, tenantId, async (tx) => {
    // ⚠ LOCKED, SO TWO POLLS OF ONE ENDPOINT ACKNOWLEDGE IN ORDER. Without it,
    // a slow poll acknowledging 10 could land after a fast one acknowledging
    // 20 and move the stored cursor backwards.
    const [endpoint] = await tx
      .select({
        kind: webhookEndpoints.kind,
        enabled: webhookEndpoints.enabled,
        pollCursor: webhookEndpoints.pollCursor,
        nextSequence: webhookEndpoints.nextSequence,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId))
      .for("update")
    if (!endpoint) return { status: "not_found" as const }
    if (endpoint.kind !== "polling") return { status: "not_polling" as const }
    if (!endpoint.enabled) return { status: "paused" as const }
    if (input.cursor !== undefined && input.cursor > endpoint.nextSequence) {
      return {
        status: "rejected" as const,
        reason: "That cursor is ahead of anything this endpoint has been sent.",
      }
    }

    const from = input.cursor ?? endpoint.pollCursor
    if (input.cursor !== undefined && input.cursor > endpoint.pollCursor) {
      await tx
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          nextAttemptAt: null,
        })
        .where(
          and(
            eq(webhookDeliveries.endpointId, endpointId),
            eq(webhookDeliveries.status, "pending"),
            lte(webhookDeliveries.sequence, input.cursor),
          ),
        )
    }
    await tx
      .update(webhookEndpoints)
      .set({
        lastPolledAt: new Date(),
        pollCursor: sql`greatest(${webhookEndpoints.pollCursor}, ${from})`,
      })
      .where(eq(webhookEndpoints.id, endpointId))

    // ⚠ A POLL IS THE SUCCESS. An endpoint that is polling is reachable, which
    // is all health asks; one that had gone quiet and comes back recovers
    // (#284), and the engine's tick fans the change out.
    const healthChange = await onDelivered(tx, tenantId, endpointId)

    const rows = await tx
      .select({
        id: webhookDeliveries.id,
        type: webhookDeliveries.eventType,
        occurredAt: webhookDeliveries.occurredAt,
        sequence: webhookDeliveries.sequence,
        payload: webhookDeliveries.payload,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.endpointId, endpointId),
          gt(webhookDeliveries.sequence, from),
        ),
      )
      .orderBy(asc(webhookDeliveries.sequence))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    return {
      status: "ok" as const,
      // The same envelope an HTTP endpoint is POSTed (events.ts `envelope`).
      data: page.map((r) => ({
        id: r.id,
        type: r.type as WebhookEventType,
        created_at: r.occurredAt.toISOString(),
        sequence: r.sequence!,
        data: (r.payload ?? {}) as Record<string, unknown>,
      })),
      next_cursor: String(page.length > 0 ? page[page.length - 1]!.sequence : from),
      done: rows.length <= limit,
      healthChange,
    }
  })
}

/**
 * Polling endpoints that have gone quiet with events waiting (#284 for
 * pollers): failing once nothing has been polled for the failing threshold,
 * disabled after the plan's stretch. Run by the engine's tick on every
 * replica; the transitions are the same guarded updates as for HTTP, so two
 * replicas report one change.
 *
 * ⚠ ONLY WITH EVENTS WAITING. A poller with nothing to collect is not failing
 * by not collecting it.
 */
export async function checkPollers(
  db: Database,
  opts: { failingAfterSeconds?: number; rules?: RetryRules } = {},
): Promise<Array<{ tenantId: string; eventId: string }>> {
  const failingAfter = opts.failingAfterSeconds ?? FAILING_AFTER_SECONDS
  const rules = opts.rules ?? RULES
  const overdue = (await db.execute(
    sql`select * from core.webhook_pollers_overdue(${`${failingAfter} seconds`}::interval)`,
  )) as unknown as Array<Record<string, unknown>>

  const changes: Array<{ tenantId: string; eventId: string }> = []
  for (const row of overdue) {
    const tenantId = String(row.tenant_id)
    const endpointId = String(row.endpoint_id)
    const quietSince = new Date(row.quiet_since as string | Date)
    const policy =
      rules.policies[row.retry_policy as RetryPolicy] ?? rules.policies.free
    const quietSeconds = (Date.now() - quietSince.getTime()) / 1000
    const ids = await withTenant(db, tenantId, async (tx) => {
      const out: string[] = []
      // The failing run began when the customer stopped collecting.
      await tx
        .update(webhookEndpoints)
        .set({ failingSince: quietSince })
        .where(
          and(
            eq(webhookEndpoints.id, endpointId),
            isNull(webhookEndpoints.failingSince),
          ),
        )
      const minutes = Math.round(quietSeconds / 60)
      const failing = await onFailed(
        tx,
        tenantId,
        endpointId,
        `Not polled for ${minutes} minute${minutes === 1 ? "" : "s"} with events waiting.`,
        failingAfter,
      )
      if (failing) out.push(failing)

      if (quietSeconds >= policy.disableAfterSeconds) {
        const days = Math.round(policy.disableAfterSeconds / 86_400)
        const reason = `Not polled for ${days} day${days === 1 ? "" : "s"} with events waiting.`
        const [off] = await tx
          .update(webhookEndpoints)
          .set({
            enabled: false,
            health: "disabled",
            healthChangedAt: new Date(),
            disabledAt: new Date(),
            disabledReason: reason,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(webhookEndpoints.id, endpointId),
              eq(webhookEndpoints.enabled, true),
            ),
          )
          .returning({ failingSince: webhookEndpoints.failingSince })
        if (off)
          out.push(
            await onDisabled(tx, {
              tenantId,
              endpointId,
              url: null,
              reason,
              failingSince: off.failingSince,
            }),
          )
      }
      return out
    })
    for (const eventId of ids) changes.push({ tenantId, eventId })
  }
  return changes
}
