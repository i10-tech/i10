import { and, desc, eq, isNull, lte, sql } from "drizzle-orm"
import { ts, withTenant, type Database } from "../db/client.js"
import { sesReputationFindings, sesReputationSnapshots } from "../db/core.js"
import type { FindingImpact, SesSendingStatus } from "./event.js"

export interface FindingOpen {
  tenantId: string
  type: string
  impact: FindingImpact
  description: string | null
  at: Date
  source: "event" | "poll"
}

export interface OpenFinding {
  id: string
  type: string
  impact: FindingImpact
  description: string | null
  openedAt: Date
  lastSeenAt: Date
  notifiedAt: Date | null
}

/** Per-recipient counts over a window, from our own `message_events`. */
export interface SendingCounts {
  sends: number
  hardBounces: number
  softBounces: number
  complaints: number
}

export interface Snapshot {
  tenantId: string
  day: string
  sendingStatus: SesSendingStatus | null
  impact: FindingImpact | null
  policy: string | null
  day1: SendingCounts
  day7: SendingCounts
}

/**
 * Where a workspace's SES reputation lives (#158).
 *
 * ⚠ EVERY CALL IS INSIDE `withTenant` FOR THE WORKSPACE THE TENANT NAME NAMES,
 * as in store.ts - no cross-tenant read, no definer function.
 */
export interface ReputationStore {
  /**
   * Opens a finding, or refreshes the one already open for the same
   * (tenant, type, impact). `stale` when an event arrives for an episode we
   * have already seen resolved after it - SNS delivering Open after Resolved.
   */
  open(finding: FindingOpen): Promise<
    | { outcome: "stale" }
    | {
        outcome: "opened" | "seen"
        id: string
        notifiedAt: Date | null
      }
  >
  /**
   * Resolves the open finding(s) of a type - of one impact, or of any when
   * `impact` is null. Returns how many closed.
   *
   * ⚠ ONLY EPISODES OPENED BEFORE `at`. A Resolved that SNS delivers late must
   * not close the episode that opened after it.
   */
  resolve(
    tenantId: string,
    type: string,
    impact: FindingImpact | null,
    at: Date,
  ): Promise<number>
  openFindings(tenantId: string): Promise<OpenFinding[]>
  markNotified(tenantId: string, findingId: string): Promise<void>
  counts(tenantId: string, since: Date): Promise<SendingCounts>
  snapshot(snapshot: Snapshot): Promise<void>
}

export function reputationStore(db: Database): ReputationStore {
  const f = sesReputationFindings

  return {
    async open(finding) {
      return withTenant(db, finding.tenantId, async (tx) => {
        if (finding.source === "event") {
          const [later] = await tx
            .select({ id: f.id })
            .from(f)
            .where(
              and(
                eq(f.tenantId, finding.tenantId),
                eq(f.type, finding.type),
                eq(f.impact, finding.impact),
                sql`${f.resolvedAt} >= ${ts(finding.at)}`,
              ),
            )
            .limit(1)
          const [open] = await tx
            .select({ id: f.id })
            .from(f)
            .where(
              and(
                eq(f.tenantId, finding.tenantId),
                eq(f.type, finding.type),
                eq(f.impact, finding.impact),
                isNull(f.resolvedAt),
              ),
            )
            .limit(1)
          if (later && !open) return { outcome: "stale" as const }
        }

        const [row] = await tx
          .insert(f)
          .values({
            tenantId: finding.tenantId,
            type: finding.type,
            impact: finding.impact,
            description: finding.description,
            openedAt: finding.at,
            lastSeenAt: finding.at,
            source: finding.source,
          })
          .onConflictDoUpdate({
            target: [f.tenantId, f.type, f.impact],
            targetWhere: sql`${f.resolvedAt} is null`,
            set: {
              // ⚠ SES REWRITES THE DESCRIPTION AS THE RATE MOVES. The latest
              // is the one worth showing; an event without one keeps ours.
              description: sql`coalesce(excluded.description, ${f.description})`,
              lastSeenAt: sql`greatest(${f.lastSeenAt}, excluded.last_seen_at)`,
              // The poll's `CreatedTimestamp` is SES's own and earlier than any
              // event time; the first sight of an episode should say when SES
              // opened it, not when we heard.
              openedAt: sql`least(${f.openedAt}, excluded.opened_at)`,
            },
          })
          .returning({
            id: f.id,
            notifiedAt: f.notifiedAt,
            // ⚠ `xmax = 0` means the upsert inserted. It only labels the log
            // line - notifying keys on `notified_at`, never on this.
            inserted: sql<boolean>`(xmax = 0)`,
          })
        if (!row) throw new Error("finding upsert returned nothing")
        return {
          outcome: row.inserted ? ("opened" as const) : ("seen" as const),
          id: row.id,
          notifiedAt: row.notifiedAt,
        }
      })
    },

    async resolve(tenantId, type, impact, at) {
      const closed = await withTenant(db, tenantId, (tx) =>
        tx
          .update(f)
          .set({ resolvedAt: at })
          .where(
            and(
              eq(f.tenantId, tenantId),
              eq(f.type, type),
              impact ? eq(f.impact, impact) : undefined,
              isNull(f.resolvedAt),
              lte(f.openedAt, at),
            ),
          )
          .returning({ id: f.id }),
      )
      return closed.length
    },

    async openFindings(tenantId) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: f.id,
            type: f.type,
            impact: f.impact,
            description: f.description,
            openedAt: f.openedAt,
            lastSeenAt: f.lastSeenAt,
            notifiedAt: f.notifiedAt,
          })
          .from(f)
          .where(and(eq(f.tenantId, tenantId), isNull(f.resolvedAt)))
          // HIGH first, then newest: the order the console shows them in.
          .orderBy(f.impact, desc(f.openedAt)),
      )
    },

    async markNotified(tenantId, findingId) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(f)
          .set({ notifiedAt: new Date() })
          .where(and(eq(f.tenantId, tenantId), eq(f.id, findingId))),
      )
    },

    async counts(tenantId, since) {
      /*
       * ⚠ PER RECIPIENT, LIKE SES. One message to five people that hard-bounces
       * for two is two bounces out of five sends, not one out of one. The raw
       * SES notification is what `message_events.payload` holds, so the
       * recipient arrays are read straight from it.
       *
       * ⚠ HARD IS `Permanent` ONLY - the suppression rule's line, and SES's
       * bounce-rate line. `Transient` and `Undetermined` are soft.
       */
      const rows = (await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          select
            coalesce(sum(case when type = 'sent'
              then ${recipients(sql`payload->'mail'->'destination'`)} end), 0)::int as sends,
            coalesce(sum(case when type = 'bounced'
                and payload->'bounce'->>'bounceType' = 'Permanent'
              then ${recipients(sql`payload->'bounce'->'bouncedRecipients'`)} end), 0)::int
              as hard_bounces,
            coalesce(sum(case when type = 'bounced'
                and coalesce(payload->'bounce'->>'bounceType', '') <> 'Permanent'
              then ${recipients(sql`payload->'bounce'->'bouncedRecipients'`)} end), 0)::int
              as soft_bounces,
            coalesce(sum(case when type = 'complained'
              then ${recipients(sql`payload->'complaint'->'complainedRecipients'`)} end), 0)::int
              as complaints
          from core.message_events
          where tenant_id = ${tenantId}
            and occurred_at >= ${ts(since)}
            and type in ('sent', 'bounced', 'complained')
        `),
      )) as unknown as {
        sends: number
        hard_bounces: number
        soft_bounces: number
        complaints: number
      }[]
      const r = rows[0]
      return {
        sends: Number(r?.sends ?? 0),
        hardBounces: Number(r?.hard_bounces ?? 0),
        softBounces: Number(r?.soft_bounces ?? 0),
        complaints: Number(r?.complaints ?? 0),
      }
    },

    async snapshot(s) {
      const values = {
        sendingStatus: s.sendingStatus,
        impact: s.impact,
        policy: s.policy,
        sends24h: s.day1.sends,
        hardBounces24h: s.day1.hardBounces,
        softBounces24h: s.day1.softBounces,
        complaints24h: s.day1.complaints,
        sends7d: s.day7.sends,
        hardBounces7d: s.day7.hardBounces,
        softBounces7d: s.day7.softBounces,
        complaints7d: s.day7.complaints,
        takenAt: new Date(),
      }
      // ⚠ ONE ROW A DAY, AND A RE-RUN REPLACES IT. The CronJob retries a failed
      // pod; the second run's numbers are the fresher ones.
      await withTenant(db, s.tenantId, (tx) =>
        tx
          .insert(sesReputationSnapshots)
          .values({ tenantId: s.tenantId, day: s.day, ...values })
          .onConflictDoUpdate({
            target: [sesReputationSnapshots.tenantId, sesReputationSnapshots.day],
            set: values,
          }),
      )
    },
  }
}

/**
 * How many recipients a JSON array names. ⚠ A payload without the array still
 * counts once: a `Send` event always has at least one recipient, and dropping
 * it would understate sends and so overstate every rate.
 */
const recipients = (path: ReturnType<typeof sql>) =>
  sql`greatest(coalesce(case when jsonb_typeof(${path}) = 'array'
    then jsonb_array_length(${path}) end, 1), 1)`
