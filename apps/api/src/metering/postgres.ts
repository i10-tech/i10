import { sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import { withTenant, type Database } from "../db/client.js"
import type {
  Assignment,
  AssignmentStore,
  MeterKey,
  RecordResult,
  ResetWindow,
  UsageEvent,
  UsageStore,
} from "@repo/metering"

/**
 * The Postgres side of `@repo/metering`: the ledger, and who is on what plan.
 *
 * ⚠ THE PACKAGE COULD NOT CONTAIN THIS FILE, AND THAT IS THE POINT OF THE
 * PORTS. `@repo/metering` compiles without Node types so that the same
 * arithmetic runs unchanged in a Durable Object; a Drizzle adapter cannot exist
 * on that side of the line. It lives here, next to the schema and the migration
 * it depends on, and the core is handed it.
 *
 * ⚠ EVERY STATEMENT GOES THROUGH `withTenant`, INCLUDING THE READS. Row level
 * security is what keeps one tenant's usage out of another's balance, and the
 * policies read `app.tenant_id`, which only a `withTenant` transaction sets. A
 * query issued outside one does not return the wrong rows — it raises, which is
 * the behaviour 0002 chose deliberately over failing closed and looking like an
 * empty account.
 *
 * The statement builders are exported because the properties that matter here
 * are not visible in a return value — that the anchor is absent from the DO
 * UPDATE, that the window is half-open, that the conflict does nothing rather
 * than something. Those live in the SQL text, and test/metering-sql.test.ts
 * asserts them there. Same approach as db/claim.ts.
 */

/**
 * ⚠ THE STORED JSON IS PARSED, NOT TRUSTED. `$type` on the column is erased at
 * compile time; what is actually in there is whatever a migration, a config
 * push or somebody's psql session wrote. An entitlement with a misspelled
 * interval would otherwise flow into the window arithmetic and produce a
 * confidently wrong boundary.
 */
const entitlement = z.object({
  featureId: z.string().min(1),
  allowance: z.union([z.number().nonnegative(), z.literal("unlimited")]),
  interval: z.enum(["day", "week", "month", "year", "lifetime"]),
  intervalCount: z.number().int().positive().optional(),
})

const entitlements = z.array(entitlement)

const planRow = z.object({
  plan_id: z.string(),
  source: z.enum(["catalog", "custom"]),
  entitlements: z.unknown(),
  anchor: z.date(),
})

/** One tenant's plan and anchor, or nothing. */
export const assignmentStatement = (tenantId: string): SQL => sql`
  select p.id as plan_id, p.source, p.entitlements, a.anchor
    from core.plan_assignments a
    join core.plans p on p.id = a.plan_id
   where a.tenant_id = ${tenantId}::uuid
   limit 1
`

/**
 * Put a tenant on a plan.
 *
 * ⚠ `anchor` IS ABSENT FROM THE `DO UPDATE SET`, AND THAT OMISSION IS THE RULE
 * ITSELF RATHER THAN AN OVERSIGHT. Re-anchoring on every assignment would hand
 * every customer a free reset — exhaust the allowance, change plan, start a
 * fresh window, repeat — and would make the old and new windows overlap at the
 * moment of the change, so the same usage falls inside both and the ledger's
 * buckets stop partitioning time. The column is written once, on the insert,
 * and never again.
 */
export const assignStatement = (input: {
  tenantId: string
  planId: string
  anchor: Date
}): SQL => sql`
  insert into core.plan_assignments (tenant_id, plan_id, anchor)
  values (${input.tenantId}::uuid, ${input.planId}, ${input.anchor})
  on conflict (tenant_id) do update
     set plan_id    = excluded.plan_id,
         updated_at = now()
`

/**
 * What this meter has consumed inside a window.
 *
 * ⚠ HALF-OPEN, MATCHING `windowFor`. `>= start` and `< end`, so an event landing
 * exactly on a boundary is counted in the window it opens and in no other. Both
 * ends inclusive would bill a tick twice and put the two sides of the
 * reconciler permanently out of step by however many events fell on it.
 *
 * ⚠ AND IT IS SCOPED TO ONE SHARD, BECAUSE THE GATE IS. A shard draws against
 * its own slice of the allowance and never reads its siblings; summing them is
 * a reporting query, not something a send waits for.
 */
export const usedInStatement = (key: MeterKey, window: ResetWindow): SQL => sql`
  select coalesce(sum(value), 0)::bigint as used
    from core.meter_events
   where tenant_id   = ${key.tenantId}::uuid
     and feature_id  = ${key.featureId}
     and shard       = ${key.shard}
     and occurred_at >= ${window.start}
     ${window.end === null ? sql`` : sql`and occurred_at < ${window.end}`}
`

/**
 * Append usage.
 *
 * ⚠ `ON CONFLICT DO NOTHING`, WHICH IS WHAT MAKES THE WHOLE PIPELINE RETRYABLE.
 * The send path deliberately takes a gap over a duplicate and lets the
 * reconciler top it up, and the reconciler can only do that because presenting
 * the same `messageId` twice is free. `DO UPDATE` would be worse than useless
 * here: a replay carrying a different `value` would silently rewrite history.
 *
 * ⚠ AND `RETURNING` IS HOW DUPLICATES ARE COUNTED. Rows suppressed by the
 * conflict are not returned, so the difference between what was sent and what
 * came back is the number that were already there — a signal worth logging,
 * because a rate of duplicates that is not near zero means something upstream
 * is retrying much harder than it should be.
 */
export const recordStatement = (
  key: MeterKey,
  events: readonly UsageEvent[],
): SQL => sql`
  insert into core.meter_events
    (tenant_id, feature_id, event_id, shard, value, occurred_at)
  values ${sql.join(
    events.map(
      (event) => sql`(
      ${key.tenantId}::uuid, ${key.featureId}, ${event.id},
      ${key.shard}, ${event.value}, ${event.at}
    )`,
    ),
    sql`, `,
  )}
  on conflict (tenant_id, feature_id, event_id) do nothing
  returning event_id
`

export interface PlanAssignments extends AssignmentStore {
  /**
   * ⚠ THE ONLY WAY A TENANT GETS AN ALLOWANCE, AND IT TAKES NO MONEY. Whether
   * anybody paid is decided in billing/grants.ts against a signature-verified
   * Polar event, exactly as it was for Autumn's `grantPlan`. This writes a row.
   */
  assign(input: { tenantId: string; planId: string; anchor: Date }): Promise<void>
}

export function planAssignmentStore(db: Database): PlanAssignments {
  return {
    async find(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = (await tx.execute(
          assignmentStatement(tenantId),
        )) as unknown as unknown[]

        const first = rows[0]
        if (first === undefined) return null

        const row = planRow.parse(first)

        // ⚠ A MALFORMED PLAN THROWS RATHER THAN RESOLVING TO NOTHING. `null`
        // here means "this tenant holds no plan", which is a fact about the
        // customer; a catalogue row we cannot read is a fact about us. Letting
        // the second wear the first's clothes would tell a paying customer they
        // are over quota because somebody mistyped an interval.
        return {
          tenantId,
          anchor: row.anchor,
          plan: {
            id: row.plan_id,
            source: row.source,
            entitlements: entitlements.parse(row.entitlements),
          },
        } satisfies Assignment
      })
    },

    async assign({ tenantId, planId, anchor }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(assignStatement({ tenantId, planId, anchor }))
      })
    },
  }
}

export function meterEventStore(db: Database): UsageStore {
  return {
    async usedIn(key, window) {
      return withTenant(db, key.tenantId, async (tx) => {
        const rows = (await tx.execute(usedInStatement(key, window))) as unknown as {
          used: string | number
        }[]
        // ⚠ `sum()` OVER A bigint COMES BACK AS A STRING from postgres-js, and
        // `"0" > 100` is false while `"90" > 100` is also false — a string
        // comparison that looks like it works right up until it does not.
        return Number(rows[0]?.used ?? 0)
      })
    },

    async record(key, events) {
      const unique = dedupe(events)
      if (unique.length === 0) return { recorded: 0, duplicates: 0 }

      for (const event of unique) {
        if (!Number.isInteger(event.value) || event.value < 0) {
          throw new RangeError(
            `usage value must be a non-negative integer, got ${event.value}`,
          )
        }
      }

      return withTenant(db, key.tenantId, async (tx) => {
        const inserted = (await tx.execute(
          recordStatement(key, unique),
        )) as unknown as unknown[]

        // ⚠ COUNTED AGAINST WHAT THE CALLER HANDED US, NOT AGAINST THE
        // DEDUPED LIST. Otherwise the same id twice in one batch is collapsed
        // below and reported as two fresh units, and an upstream that is
        // double-submitting stays invisible in the one number that would show
        // it.
        return {
          recorded: inserted.length,
          duplicates: events.length - inserted.length,
        } satisfies RecordResult
      })
    },
  }
}

/**
 * ⚠ WITHIN ONE BATCH ONLY — the database handles duplicates across batches.
 * This is here for the statement, not for the arithmetic: repeating a key
 * inside a single `VALUES` list makes the insert depend on how Postgres
 * resolves a row conflicting with one it is inserting in the same command,
 * which is exactly the kind of detail that behaves one way until a version
 * upgrade. Collapsing first makes the statement say what it means. The counts
 * above are still taken against the original list, so nothing is hidden.
 */
function dedupe(events: readonly UsageEvent[]): UsageEvent[] {
  const seen = new Map<string, UsageEvent>()
  for (const event of events) if (!seen.has(event.id)) seen.set(event.id, event)
  return [...seen.values()]
}
