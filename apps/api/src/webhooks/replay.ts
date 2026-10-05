import type { WebhookReplay } from "@repo/contracts"
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm"
import type { Queue } from "groupmq"
import { withTenant, type Database } from "../db/client.js"
import {
  messageEvents,
  planAssignments,
  webhookDeliveries,
  webhookEndpoints,
  webhookReplays,
} from "../db/core.js"
import { enqueueDelivery, type WebhookJob } from "../queue/webhook-queue.js"
import {
  domainOf,
  interpretSesEvent,
  type Logger,
  type NormalisedEvent,
} from "./events.js"
import { policyForPlan } from "./schedule.js"
import { interpretStalwartEvent, type StalwartEvent } from "./stalwart.js"

/**
 * Sending webhooks again (#282): one delivery, or every delivery in a window,
 * or the events an endpoint never got.
 *
 * ⚠ EVERY ONE IS A SINGLE ATTEMPT (deliver.ts). A person asked for it; if it
 * fails they see the attempt in the log and decide, and it never counts
 * against the endpoint.
 */

/** What a replay was asked for. Times are ISO strings. */
export interface ReplayFilter {
  since: string
  until: string
  /** For `replay`: which finished deliveries. */
  statuses?: ("delivered" | "failed")[]
  /** For `replay`: one event type only. */
  eventType?: string
}

/** The widest window one replay may cover. */
export const MAX_REPLAY_DAYS = 31
/** Rows per batch; the cursor is written after each. */
export const REPLAY_BATCH = 100

type ReplayRow = typeof webhookReplays.$inferSelect

export const presentReplay = (r: ReplayRow): WebhookReplay => ({
  object: "webhook_replay",
  id: r.id,
  endpoint_id: r.endpointId,
  kind: r.kind,
  status: r.status,
  filter: {
    since: r.filter.since,
    until: r.filter.until,
    ...(r.filter.statuses ? { statuses: r.filter.statuses } : {}),
    ...(r.filter.eventType ? { event_type: r.filter.eventType } : {}),
  },
  queued: r.queued,
  examined: r.examined,
  error: r.error,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
  finished_at: r.finishedAt?.toISOString() ?? null,
})

/** Why a polling endpoint is never replayed: the cursor already does it (#301). */
export const POLLING_REPLAY =
  "A polling endpoint is not sent to, so there is nothing to replay: poll again from an earlier cursor to read its events again."

export type ResendResult =
  | { status: "queued"; deliveryId: string }
  | { status: "pending" }
  | { status: "paused" }
  /** A polling endpoint's events are read again by polling from an older cursor. */
  | { status: "polling" }
  | { status: "not_found" }

/**
 * Sends one finished delivery again, now, under its own id - so a receiver
 * that already processed it can tell it is the same event.
 */
export async function resendDelivery(
  db: Database,
  queue: Queue<WebhookJob>,
  tenantId: string,
  deliveryId: string,
): Promise<ResendResult> {
  const row = await withTenant(db, tenantId, async (tx) => {
    const [d] = await tx
      .select({
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        endpointId: webhookDeliveries.endpointId,
        enabled: webhookEndpoints.enabled,
        kind: webhookEndpoints.kind,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookEndpoints,
        eq(webhookEndpoints.id, webhookDeliveries.endpointId),
      )
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1)
    if (!d) return { status: "not_found" as const }
    if (d.kind === "polling") return { status: "polling" as const }
    // Still being attempted: it already has a next attempt; a second would race it.
    if (d.status === "pending") return { status: "pending" as const }
    if (!d.enabled) return { status: "paused" as const }
    await reopen(tx, [deliveryId])
    return {
      status: "reopened" as const,
      endpointId: d.endpointId,
      attempts: d.attempts,
    }
  })
  if (row.status !== "reopened") return row
  // If this fails the row is pending and due, and the sweep sends it.
  await enqueueDelivery(
    queue,
    {
      deliveryId,
      endpointId: row.endpointId,
      tenantId,
      attempt: row.attempts,
      trigger: "manual",
    },
    { orderMs: Date.now(), jobTag: `m${Date.now()}` },
  )
  return { status: "queued", deliveryId }
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]

/** Puts finished deliveries back to owed-now, for one more attempt. */
async function reopen(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await tx
    .update(webhookDeliveries)
    .set({
      status: "pending",
      nextAttemptAt: sql`now()`,
      claimedUntil: null,
      firstFailedAt: null,
      // A replay is not part of the endpoint's ordered stream any more.
      lane: "retry",
    })
    .where(
      and(inArray(webhookDeliveries.id, ids), ne(webhookDeliveries.status, "pending")),
    )
    .returning({ id: webhookDeliveries.id })
  return rows.map((r) => r.id)
}

export type CreateReplayResult =
  | { status: "created"; replay: WebhookReplay }
  | { status: "rejected"; reason: string }
  | { status: "paused" }
  | { status: "not_found" }

export async function createReplay(
  db: Database,
  tenantId: string,
  endpointId: string,
  kind: "replay" | "replay_missing",
  input: {
    since: Date
    until?: Date
    statuses?: ("delivered" | "failed")[]
    eventType?: string
  },
): Promise<CreateReplayResult> {
  const until = input.until ?? new Date()
  if (input.since >= until) {
    return { status: "rejected", reason: "`since` must be before `until`." }
  }
  if (until.getTime() - input.since.getTime() > MAX_REPLAY_DAYS * 86_400_000) {
    return {
      status: "rejected",
      reason: `One replay covers at most ${MAX_REPLAY_DAYS} days; start another for the rest.`,
    }
  }
  return withTenant(db, tenantId, async (tx) => {
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
    if (endpoint.kind === "polling")
      return { status: "rejected" as const, reason: POLLING_REPLAY }
    // ⚠ NOT TO A SWITCHED-OFF ENDPOINT. Every delivery would be refused by the
    // worker as "endpoint disabled" and the replay would look like it ran.
    if (!endpoint.enabled) return { status: "paused" as const }
    const [row] = await tx
      .insert(webhookReplays)
      .values({
        tenantId,
        endpointId,
        kind,
        filter: {
          since: input.since.toISOString(),
          until: until.toISOString(),
          ...(kind === "replay" ? { statuses: input.statuses ?? ["failed"] } : {}),
          ...(kind === "replay" && input.eventType
            ? { eventType: input.eventType }
            : {}),
        },
      })
      .returning()
    return { status: "created" as const, replay: presentReplay(row!) }
  })
}

export async function getReplay(
  db: Database,
  tenantId: string,
  id: string,
): Promise<WebhookReplay | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(webhookReplays)
      .where(eq(webhookReplays.id, id))
      .limit(1)
    return row ? presentReplay(row) : null
  })
}

export async function listReplays(
  db: Database,
  tenantId: string,
  endpointId: string,
): Promise<WebhookReplay[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(webhookReplays)
      .where(eq(webhookReplays.endpointId, endpointId))
      .orderBy(desc(webhookReplays.createdAt))
      .limit(50)
    return rows.map(presentReplay)
  })
}

/** Rebuilds a stored notification the way ingestion first read it. */
function reinterpret(row: {
  payload: unknown
  sourceEventId: string | null
  occurredAt: Date
}): NormalisedEvent | null {
  if (!row.payload) return null
  if (row.sourceEventId?.startsWith("stalwart_")) {
    return interpretStalwartEvent(row.payload as StalwartEvent, row.occurredAt)
  }
  return interpretSesEvent(row.payload, row.sourceEventId ?? "", row.occurredAt)
}

/**
 * Works one batch of each replay that needs a worker. Called by the engine on
 * its sweep tick, so it runs on every replica; the lease means one batch of a
 * replay runs at a time.
 */
export async function runDueReplays(
  db: Database,
  queue: Queue<WebhookJob>,
  log: Logger,
  limit = 5,
): Promise<number> {
  const due = (await db.execute(
    sql`select id::text, tenant_id::text from core.webhook_replays_due(${limit}::int)`,
  )) as unknown as { id: string; tenant_id: string }[]
  let worked = 0
  for (const r of due) {
    try {
      if (await runBatch(db, queue, r.tenant_id, r.id)) worked++
    } catch (err) {
      log.warn({ err: String(err), replayId: r.id }, "webhook replay batch failed")
      await withTenant(db, r.tenant_id, (tx) =>
        tx
          .update(webhookReplays)
          .set({
            status: "failed",
            error: String(err).slice(0, 500),
            claimedUntil: null,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(webhookReplays.id, r.id)),
      )
    }
  }
  return worked
}

async function runBatch(
  db: Database,
  queue: Queue<WebhookJob>,
  tenantId: string,
  replayId: string,
): Promise<boolean> {
  const out = await withTenant(db, tenantId, async (tx) => {
    // ⚠ LEASED FOR THE BATCH. Two workers that both saw this replay due race
    // here, and only one gets the row.
    const [replay] = await tx
      .update(webhookReplays)
      .set({
        claimedUntil: sql`now() + interval '60 seconds'`,
        status: "running",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(webhookReplays.id, replayId),
          inArray(webhookReplays.status, ["queued", "running"]),
          sql`(${webhookReplays.claimedUntil} is null or ${webhookReplays.claimedUntil} < now())`,
        ),
      )
      .returning()
    if (!replay) return null

    // Switched off since the replay started: stop, and say why.
    const [target] = await tx
      .select({ enabled: webhookEndpoints.enabled })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, replay.endpointId))
      .limit(1)
    if (!target?.enabled) {
      await tx
        .update(webhookReplays)
        .set({
          status: "failed",
          error: "The endpoint was paused or switched off during the replay.",
          claimedUntil: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(webhookReplays.id, replayId))
      return null
    }

    const f = replay.filter
    const after = replay.cursor
      ? sql`(${replay.kind === "replay" ? webhookDeliveries.createdAt : messageEvents.occurredAt}, ${
          replay.kind === "replay" ? webhookDeliveries.id : messageEvents.id
        }) > (${replay.cursor.at}::timestamptz, ${replay.cursor.id}::uuid)`
      : sql`true`

    let examined = 0
    let cursor: { at: string; id: string } | null = replay.cursor ?? null
    const toQueue: { id: string; occurredAt: Date }[] = []

    if (replay.kind === "replay") {
      const where: SQL[] = [
        eq(webhookDeliveries.endpointId, replay.endpointId),
        inArray(webhookDeliveries.status, f.statuses ?? ["failed"]),
        sql`${webhookDeliveries.createdAt} >= ${f.since}::timestamptz`,
        sql`${webhookDeliveries.createdAt} < ${f.until}::timestamptz`,
        after,
      ]
      if (f.eventType)
        where.push(sql`${webhookDeliveries.eventType}::text = ${f.eventType}`)
      const rows = await tx
        .select({
          id: webhookDeliveries.id,
          occurredAt: webhookDeliveries.occurredAt,
          at: sql<string>`${webhookDeliveries.createdAt}::text`,
        })
        .from(webhookDeliveries)
        .where(and(...where))
        .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
        .limit(REPLAY_BATCH)
      examined = rows.length
      const last = rows[rows.length - 1]
      if (last) cursor = { at: last.at, id: last.id }
      const reopened = new Set(
        await reopen(
          tx,
          rows.map((r) => r.id),
        ),
      )
      for (const r of rows) if (reopened.has(r.id)) toQueue.push(r)
    } else {
      const [endpoint] = await tx
        .select({
          events: webhookEndpoints.events,
          enabled: webhookEndpoints.enabled,
          filterDomains: webhookEndpoints.filterDomains,
          filterTags: webhookEndpoints.filterTags,
        })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, replay.endpointId))
        .limit(1)
      if (!endpoint) return { done: true, examined: 0, cursor, toQueue }
      const [assignment] = await tx
        .select({ planId: planAssignments.planId })
        .from(planAssignments)
        .where(eq(planAssignments.tenantId, tenantId))
        .limit(1)
      const logTypes = endpoint.events.map((e) => e.replace(/^email\./, ""))
      // ⚠ "NEVER RECEIVED" MEANS NO DELIVERY TO THIS ENDPOINT FOR THIS EVENT
      // OF THIS MESSAGE, whatever its status. A failed delivery was received
      // as far as this goes - that is what `replay` with failed is for.
      const rows = await tx
        .select({
          id: messageEvents.id,
          messageId: messageEvents.messageId,
          occurredAt: messageEvents.occurredAt,
          sourceEventId: messageEvents.sourceEventId,
          payload: messageEvents.payload,
          at: sql<string>`${messageEvents.occurredAt}::text`,
        })
        .from(messageEvents)
        .where(
          and(
            sql`${messageEvents.occurredAt} >= ${f.since}::timestamptz`,
            sql`${messageEvents.occurredAt} < ${f.until}::timestamptz`,
            sql`${messageEvents.type}::text = any(${`{${logTypes.join(",")}}`}::text[])`,
            sql`not exists (
              select 1 from core.webhook_deliveries d
               where d.endpoint_id = ${replay.endpointId}
                 and d.message_id = ${messageEvents.messageId}
                 and d.event_type::text = 'email.' || ${messageEvents.type}::text
            )`,
            after,
          ),
        )
        .orderBy(asc(messageEvents.occurredAt), asc(messageEvents.id))
        .limit(REPLAY_BATCH)
      examined = rows.length
      const last = rows[rows.length - 1]
      if (last) cursor = { at: last.at, id: last.id }
      for (const r of rows) {
        const event = reinterpret(r)
        if (!event) continue
        if (
          endpoint.filterDomains &&
          !endpoint.filterDomains.includes(domainOf(event.data.from) ?? "")
        )
          continue
        if (endpoint.filterTags) {
          const tags = (event.data.tags as Record<string, string> | undefined) ?? {}
          if (!Object.entries(endpoint.filterTags).every(([k, v]) => tags[k] === v))
            continue
        }
        const [created] = await tx
          .insert(webhookDeliveries)
          .values({
            tenantId,
            endpointId: replay.endpointId,
            eventType: event.type,
            occurredAt: event.occurredAt,
            messageId: event.messageId,
            payload: event.data as never,
            retryPolicy: policyForPlan(assignment?.planId),
            lane: "retry",
          })
          .returning({ id: webhookDeliveries.id })
        toQueue.push({ id: created!.id, occurredAt: event.occurredAt })
      }
    }

    const done = examined < REPLAY_BATCH
    await tx
      .update(webhookReplays)
      .set({
        cursor,
        examined: sql`${webhookReplays.examined} + ${examined}`,
        queued: sql`${webhookReplays.queued} + ${toQueue.length}`,
        status: done ? "done" : "running",
        claimedUntil: null,
        updatedAt: new Date(),
        ...(done ? { finishedAt: new Date() } : {}),
      })
      .where(eq(webhookReplays.id, replayId))
    return {
      done,
      examined,
      cursor,
      toQueue,
      kind: replay.kind,
      endpointId: replay.endpointId,
      statuses: f.statuses,
    }
  })
  if (!out) return false

  // After the commit. If queueing fails, the rows are pending and due, and the
  // sweep sends them.
  const trigger =
    out.kind === "replay" && out.statuses?.length === 1 && out.statuses[0] === "failed"
      ? ("recover" as const)
      : ("replay" as const)
  await Promise.all(
    out.toQueue.map((d) =>
      enqueueDelivery(
        queue,
        { deliveryId: d.id, endpointId: out.endpointId!, tenantId, trigger },
        { orderMs: d.occurredAt.getTime(), jobTag: `r${replayId.slice(-8)}` },
      ),
    ),
  )
  return true
}

/** The replay operations a route needs, bound to a database and a queue. */
export interface WebhookReplayOps {
  resend: (tenantId: string, deliveryId: string) => Promise<ResendResult>
  create: (
    tenantId: string,
    endpointId: string,
    kind: "replay" | "replay_missing",
    input: {
      since: Date
      until?: Date
      statuses?: ("delivered" | "failed")[]
      eventType?: string
    },
  ) => Promise<CreateReplayResult>
  get: (tenantId: string, id: string) => Promise<WebhookReplay | null>
  list: (tenantId: string, endpointId: string) => Promise<WebhookReplay[]>
}

export const webhookReplayOps = (
  db: Database,
  queue: Queue<WebhookJob>,
): WebhookReplayOps => ({
  resend: (t, id) => resendDelivery(db, queue, t, id),
  create: (t, e, kind, input) => createReplay(db, t, e, kind, input),
  get: (t, id) => getReplay(db, t, id),
  list: (t, e) => listReplays(db, t, e),
})
