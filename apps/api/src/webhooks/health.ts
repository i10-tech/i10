import { createHash } from "node:crypto"
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import type { WebhookHealthEvent } from "@repo/contracts"
import type { Queue } from "groupmq"
import { withTenant, type Database } from "../db/client.js"
import { enqueueDelivery, type WebhookJob } from "../queue/webhook-queue.js"
import {
  planAssignments,
  webhookDeliveries,
  webhookEndpoints,
  webhookHealthEvents,
} from "../db/core.js"
import { pollingRow } from "./kinds.js"
import { policyForPlan } from "./schedule.js"

/**
 * Telling a workspace about its own endpoints (#284): one starts failing, is
 * switched off, or recovers.
 *
 * ⚠ ONCE PER CHANGE, NOT ONCE PER FAILURE. An endpoint that is down fails every
 * delivery it is sent; an owner emailed per failure unsubscribes from us, and
 * one emailed never is the customer whose events quietly stopped. So the
 * endpoint row carries a `health` state, every transition is a guarded update
 * that matches only the row still in the old state, and the event row is
 * written only when that update returned something. Two workers failing two
 * deliveries to the same dead endpoint at the same instant produce one event.
 *
 * Three channels read the same rows: the console (listed by `listHealthEvents`),
 * the owner's email (`runHealthEmails`, in the API process, which has Clerk and
 * our system sender), and `webhook_endpoint.*` webhooks to the workspace's
 * other endpoints (`fanOutHealthEvent`, in the worker).
 */

/**
 * How long nothing may succeed before an endpoint counts as failing.
 *
 * ⚠ LONG ENOUGH TO RIDE OUT A DEPLOY, SHORT ENOUGH TO MATTER. A receiver
 * restarting answers 502 for a minute or two, and an email about that is noise
 * that teaches people to ignore the real one. Fifteen minutes with no success
 * at all is an outage. And it always comes before the shortest retry window
 * (free's, about 1h45m), so the owner hears that an endpoint is failing before
 * any event to it is given up on - which is why exhausted deliveries are not a
 * separate trigger: the clock has always fired first.
 */
export const FAILING_AFTER_SECONDS = 15 * 60

/**
 * The fewest minutes between two health emails to one workspace, unless an
 * endpoint was switched off: that one goes at once, because events to it have
 * stopped. Changes that wait are not dropped; they go in the next email.
 */
export const EMAIL_EVERY_MS = 30 * 60_000

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]
type Row = Record<string, unknown>

export type HealthKind = "failing" | "disabled" | "recovered"

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString()

/** Writes the event row. Called only by a transition that just happened. */
async function recordChange(
  tx: Tx,
  input: {
    tenantId: string
    endpointId: string
    kind: HealthKind
    url: string | null
    reason: string | null
    failingSince: Date | null
  },
): Promise<string> {
  const [row] = await tx
    .insert(webhookHealthEvents)
    .values({
      tenantId: input.tenantId,
      endpointId: input.endpointId,
      kind: input.kind,
      url: input.url,
      reason: input.reason?.slice(0, 2000) ?? null,
      failingSince: input.failingSince,
    })
    .returning({ id: webhookHealthEvents.id })
  return row!.id
}

/**
 * A delivery succeeded: the failing run is over, and if the endpoint was
 * failing (or disabled and since resumed), that is a recovery.
 *
 * ⚠ `old.health`, FROM THE SAME STATEMENT. Postgres 18 returns the row as it
 * was before the update, so "was it unhealthy" and "make it healthy" are one
 * atomic step - a separate read first would let two successes both see
 * `failing` and both report the recovery.
 *
 * ⚠ ONLY WHILE ENABLED. A success that lands after we switched the endpoint
 * off (an attempt already in flight) must not mark a disabled endpoint healthy
 * behind the customer's back.
 */
export async function onDelivered(
  tx: Tx,
  tenantId: string,
  endpointId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    update core.webhook_endpoints
       set failing_since = null,
           health = case when enabled then 'healthy'::core.webhook_endpoint_health else health end,
           health_changed_at = case when enabled and health <> 'healthy' then now() else health_changed_at end,
           updated_at = now()
     where id = ${endpointId}
       and (failing_since is not null or (enabled and health <> 'healthy'))
    returning old.health as previous, new.health as current, new.url as url
  `)) as unknown as Row[]
  const row = rows[0]
  if (!row || row.previous === "healthy" || row.current !== "healthy") return null
  return recordChange(tx, {
    tenantId,
    endpointId,
    kind: "recovered",
    url: row.url === null ? null : String(row.url),
    reason: null,
    failingSince: null,
  })
}

/**
 * A delivery failed on its own schedule (not a replay or a manual resend): if
 * nothing has succeeded for `failingAfterSeconds`, the endpoint is failing.
 * Called after `failing_since` is set, in the same transaction.
 */
export async function onFailed(
  tx: Tx,
  tenantId: string,
  endpointId: string,
  reason: string,
  failingAfterSeconds = FAILING_AFTER_SECONDS,
): Promise<string | null> {
  const [row] = await tx
    .update(webhookEndpoints)
    .set({ health: "failing", healthChangedAt: new Date() })
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.enabled, true),
        eq(webhookEndpoints.health, "healthy"),
        sql`${webhookEndpoints.failingSince} <= now() - ${`${failingAfterSeconds} seconds`}::interval`,
      ),
    )
    .returning({
      url: webhookEndpoints.url,
      failingSince: webhookEndpoints.failingSince,
    })
  if (!row) return null
  return recordChange(tx, {
    tenantId,
    endpointId,
    kind: "failing",
    url: row.url,
    reason,
    failingSince: row.failingSince,
  })
}

/** We just switched the endpoint off (the caller's update returned the row). */
export const onDisabled = (
  tx: Tx,
  input: {
    tenantId: string
    endpointId: string
    url: string | null
    reason: string
    failingSince: Date | null
  },
): Promise<string> => recordChange(tx, { ...input, kind: "disabled" })

// ---------------------------------------------------------------------------
// Operational webhooks
// ---------------------------------------------------------------------------

export interface FannedOut {
  id: string
  endpointId: string
  tenantId: string
  occurredAt: Date
}

/**
 * Records a `webhook_endpoint.*` delivery to every other endpoint subscribed
 * to it, and marks the event fanned out. Idempotent: an event already fanned
 * out, or held by another worker, returns nothing.
 *
 * ⚠ NEVER TO THE ENDPOINT IT IS ABOUT. "You are failing" sent to the endpoint
 * that is failing is a delivery that fails, about itself. Two endpoints
 * subscribed to each other's health cannot loop either: each change is
 * reported once, and a change takes 15 minutes or a success to happen.
 *
 * ⚠ AND MAIL FILTERS DO NOT APPLY. A domain or tag filter narrows email events;
 * these are not about any email, so an endpoint subscribed to them gets them.
 */
export async function fanOutHealthEvent(
  db: Database,
  tenantId: string,
  eventId: string,
): Promise<FannedOut[]> {
  return withTenant(db, tenantId, async (tx) => {
    const [event] = await tx
      .select()
      .from(webhookHealthEvents)
      .where(
        and(
          eq(webhookHealthEvents.id, eventId),
          isNull(webhookHealthEvents.fannedOutAt),
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1)
    if (!event) return []

    const type = `webhook_endpoint.${event.kind}` as const
    const endpoints = await tx
      .update(webhookEndpoints)
      .set({ nextSequence: sql`${webhookEndpoints.nextSequence} + 1` })
      .where(
        and(
          eq(webhookEndpoints.enabled, true),
          sql`${webhookEndpoints.id} <> ${event.endpointId}`,
          sql`${webhookEndpoints.events} @> ARRAY[${type}]::core.webhook_event_type[]`,
        ),
      )
      .returning({
        id: webhookEndpoints.id,
        sequence: webhookEndpoints.nextSequence,
        kind: webhookEndpoints.kind,
      })

    await tx
      .update(webhookHealthEvents)
      .set({ fannedOutAt: new Date() })
      .where(eq(webhookHealthEvents.id, event.id))
    if (endpoints.length === 0) return []

    const [assignment] = await tx
      .select({ planId: planAssignments.planId })
      .from(planAssignments)
      .where(eq(planAssignments.tenantId, tenantId))
      .limit(1)
    const data = {
      endpoint_id: event.endpointId,
      url: event.url,
      reason: event.reason,
      failing_since: iso(event.failingSince),
      created_at: event.occurredAt.toISOString(),
    }
    const rows = await tx
      .insert(webhookDeliveries)
      .values(
        endpoints.map((endpoint) => ({
          tenantId,
          endpointId: endpoint.id,
          retryPolicy: policyForPlan(assignment?.planId),
          sequence: endpoint.sequence,
          eventType: type,
          occurredAt: event.occurredAt,
          payload: data as never,
          ...pollingRow(endpoint.kind),
        })),
      )
      .returning({ id: webhookDeliveries.id, endpointId: webhookDeliveries.endpointId })
    const sent = new Set(endpoints.filter((e) => e.kind === "http").map((e) => e.id))
    return rows
      .filter((r) => sent.has(r.endpointId))
      .map((r) => ({
        id: r.id,
        endpointId: r.endpointId,
        tenantId,
        occurredAt: event.occurredAt,
      }))
  })
}

/**
 * Events whose fan-out did not happen after their change committed - the
 * worker stopped in between. Older than `graceSeconds`, so the worker that
 * wrote one normally gets to it first.
 */
export async function unfannedHealthEvents(
  db: Database,
  limit = 100,
): Promise<Array<{ id: string; tenantId: string }>> {
  const rows = (await db.execute(
    sql`select id, tenant_id from core.webhook_health_unfanned(${limit})`,
  )) as unknown as Row[]
  return rows.map((r) => ({ id: String(r.id), tenantId: String(r.tenant_id) }))
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface HealthEventRow {
  id: string
  endpointId: string
  kind: HealthKind
  url: string | null
  reason: string | null
  failingSince: Date | null
  occurredAt: Date
}

/** One line of the email: where an endpoint stands now. */
export interface HealthLine {
  endpointId: string
  url: string | null
  state: HealthKind
  reason: string | null
  since: Date
}

export interface HealthSummary {
  /** The worst state among the lines, which the subject names. */
  worst: HealthKind
  lines: HealthLine[]
}

const RANK: Record<HealthKind, number> = { recovered: 0, failing: 1, disabled: 2 }

/**
 * What to tell the owner about a batch of changes, or nothing.
 *
 * ⚠ ONE LINE PER ENDPOINT, ITS LATEST STATE. Failing and then disabled is
 * "disabled"; the owner needs where it stands, not its history - the console
 * has that.
 *
 * ⚠ A FAILURE THAT RECOVERED BEFORE ANYONE WAS TOLD IS NOT NEWS. When an
 * endpoint's waiting changes begin with `failing` and end with `recovered`, the
 * owner never heard it was failing, and "it recovered" would be the first they
 * hear of it. Those are dropped. A disable in between is never dropped: events
 * to it stopped, and someone has to switch it back on.
 */
export function summarize(events: HealthEventRow[]): {
  summary: HealthSummary | null
  emailed: string[]
  suppressed: string[]
} {
  const byEndpoint = new Map<string, HealthEventRow[]>()
  for (const e of [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  )) {
    const list = byEndpoint.get(e.endpointId) ?? []
    list.push(e)
    byEndpoint.set(e.endpointId, list)
  }

  const lines: HealthLine[] = []
  const emailed: string[] = []
  const suppressed: string[] = []
  for (const list of byEndpoint.values()) {
    const first = list[0]!
    const last = list[list.length - 1]!
    const blip =
      first.kind === "failing" &&
      last.kind === "recovered" &&
      !list.some((e) => e.kind === "disabled")
    if (blip) {
      suppressed.push(...list.map((e) => e.id))
      continue
    }
    emailed.push(...list.map((e) => e.id))
    lines.push({
      endpointId: last.endpointId,
      url: last.url,
      state: last.kind,
      reason: last.reason,
      since:
        last.kind === "recovered"
          ? last.occurredAt
          : (last.failingSince ?? last.occurredAt),
    })
  }
  if (lines.length === 0) return { summary: null, emailed, suppressed }
  lines.sort((a, b) => RANK[b.state] - RANK[a.state])
  return { summary: { worst: lines[0]!.state, lines }, emailed, suppressed }
}

/** Sends one workspace's summary. Built in index.ts from Clerk and our sender. */
export type HealthNotify = (
  tenantId: string,
  summary: HealthSummary,
  idempotencyKey: string,
) => Promise<void>

/**
 * Emails every workspace with health changes waiting, one email each.
 *
 * ⚠ RUN BY EVERY API REPLICA, SAFELY. A workspace's waiting rows are claimed
 * for two minutes before anything is sent, under `skip locked`, so a second
 * replica finds nothing. A send that fails leaves the claim to lapse, and the
 * next run tries again with the same key, which our sender deduplicates.
 */
export async function runHealthEmails(opts: {
  db: Database
  notify: HealthNotify
  log?: { error?: (o: object, m: string) => void }
  emailEveryMs?: number
  limit?: number
}): Promise<number> {
  const tenants = (await opts.db.execute(
    sql`select tenant_id from core.webhook_health_unemailed(${opts.limit ?? 100})`,
  )) as unknown as Row[]
  let sent = 0
  for (const t of tenants) {
    const tenantId = String(t.tenant_id)
    try {
      if (await emailTenant(opts, tenantId)) sent++
    } catch (error) {
      opts.log?.error?.({ err: error, tenantId }, "could not email webhook health")
    }
  }
  return sent
}

async function emailTenant(
  opts: { db: Database; notify: HealthNotify; emailEveryMs?: number },
  tenantId: string,
): Promise<boolean> {
  const claimed = await withTenant(opts.db, tenantId, async (tx) => {
    const waiting = await tx
      .select()
      .from(webhookHealthEvents)
      .where(
        and(
          isNull(webhookHealthEvents.emailedAt),
          or(
            isNull(webhookHealthEvents.emailClaimedUntil),
            lt(webhookHealthEvents.emailClaimedUntil, sql`now()`),
          ),
        ),
      )
      .orderBy(webhookHealthEvents.occurredAt)
      .for("update", { skipLocked: true })
    if (waiting.length === 0) return null

    // ⚠ THE LAST EMAIL ACTUALLY SENT, NOT THE LAST ROW HANDLED. A dropped blip
    // is handled without an email, and must not hold back the next real one.
    const [last] = await tx
      .select({ at: webhookHealthEvents.emailedAt })
      .from(webhookHealthEvents)
      .where(eq(webhookHealthEvents.emailSuppressed, false))
      .orderBy(sql`${webhookHealthEvents.emailedAt} desc nulls last`)
      .limit(1)
    const recent =
      last?.at && Date.now() - last.at.getTime() < (opts.emailEveryMs ?? EMAIL_EVERY_MS)
    if (recent && !waiting.some((e) => e.kind === "disabled")) return null

    await tx
      .update(webhookHealthEvents)
      .set({ emailClaimedUntil: sql`now() + interval '2 minutes'` })
      .where(
        inArray(
          webhookHealthEvents.id,
          waiting.map((e) => e.id),
        ),
      )
    return waiting
  })
  if (!claimed) return false

  const { summary, emailed, suppressed } = summarize(claimed)
  if (summary) {
    const key = createHash("sha256")
      .update(emailed.slice().sort().join(","))
      .digest("hex")
      .slice(0, 32)
    await opts.notify(tenantId, summary, `webhook-health:${tenantId}:${key}`)
  }

  await withTenant(opts.db, tenantId, async (tx) => {
    const done = async (ids: string[], emailSuppressed: boolean) => {
      if (ids.length === 0) return
      await tx
        .update(webhookHealthEvents)
        .set({ emailedAt: new Date(), emailSuppressed, emailClaimedUntil: null })
        .where(inArray(webhookHealthEvents.id, ids))
    }
    await done(emailed, false)
    await done(suppressed, true)
  })
  return summary !== null
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const presentHealthEvent = (e: HealthEventRow): WebhookHealthEvent => ({
  object: "webhook_health_event",
  id: e.id,
  endpoint_id: e.endpointId,
  kind: e.kind,
  url: e.url,
  reason: e.reason,
  failing_since: iso(e.failingSince),
  created_at: e.occurredAt.toISOString(),
})

/** Newest first; the cursor is the last id of the previous page (ids are UUIDv7). */
export async function listHealthEvents(
  db: Database,
  tenantId: string,
  q: { endpointId?: string; cursor?: string; limit?: number },
): Promise<{ data: WebhookHealthEvent[]; next_cursor: string | null }> {
  const limit = q.limit ?? 50
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(webhookHealthEvents)
      .where(
        and(
          q.endpointId ? eq(webhookHealthEvents.endpointId, q.endpointId) : undefined,
          q.cursor ? lt(webhookHealthEvents.id, q.cursor) : undefined,
        ),
      )
      .orderBy(desc(webhookHealthEvents.id))
      .limit(limit + 1),
  )
  const page = rows.slice(0, limit)
  return {
    data: page.map(presentHealthEvent),
    next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
  }
}

/**
 * Fans a change out and queues what it recorded, logging rather than throwing:
 * the tick's backlog sweep is the safety net for a failure here. The worker's
 * engine and the API's poll route both report changes through this.
 */
export const fanOutAndEnqueue =
  (
    db: Database,
    queue: Queue<WebhookJob>,
    log: { warn: (o: object, m: string) => void },
  ) =>
  (tenantId: string, eventId: string): void =>
    void fanOutHealthEvent(db, tenantId, eventId)
      .then((deliveries) =>
        Promise.all(
          deliveries.map((d) =>
            enqueueDelivery(
              queue,
              { deliveryId: d.id, endpointId: d.endpointId, tenantId: d.tenantId },
              { orderMs: d.occurredAt.getTime() },
            ),
          ),
        ),
      )
      .catch((err: unknown) =>
        log.warn(
          { err: String(err), eventId },
          "could not fan out a webhook health change; the tick will",
        ),
      )
