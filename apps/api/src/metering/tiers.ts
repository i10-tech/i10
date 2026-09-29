import {
  createMeter,
  type Assignment,
  type AssignmentStore,
  type Meter,
  type Plan,
} from "@repo/metering"
import { eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { sendingTierEvents, sendingTiers } from "../db/core.js"
import { postgresLevels } from "./levels.js"
import { meterEventStore } from "./postgres.js"

/**
 * Sending tiers for FREE workspaces (#165).
 *
 * ⚠ A SECOND CEILING, NOT A SECOND PLAN. The free plan's 100 a day still
 * applies; the tier adds a monthly line under it, so a free workspace cannot
 * spend 100 a day every day of the month - 3,000 on `normal`, 1,000 on
 * `strict`. Paid plans have no tier: what they bought is what they get, and
 * their abuse control is the risk score (#170).
 *
 * ⚠ ENFORCED BY THE SAME METER, OVER THE SAME LEDGER. The tier is expressed as
 * a one-entitlement plan and handed to `createMeter` with the ordinary usage
 * store, so the monthly window uses the tenant's own anchor (no free reset at
 * the calendar month), the arithmetic is `draw`'s, and nothing about counting
 * is written twice.
 */
export type SendingTier = "strict" | "normal"

/** Emails a month, per tier. The numbers from #165. */
export const TIER_MONTHLY_LIMITS: Readonly<Record<SendingTier, number>> = {
  strict: 1_000,
  normal: 3_000,
}

/** Where every workspace starts. #170: don't punish new legitimate users. */
export const DEFAULT_TIER: SendingTier = "normal"

export const tierPlan = (tier: SendingTier, featureId: string): Plan => ({
  id: `tier:${tier}`,
  source: "catalog",
  entitlements: [
    {
      featureId,
      kind: "consumable",
      interval: "month",
      allowance: TIER_MONTHLY_LIMITS[tier],
      // ⚠ A HARD CAP. Overage is a paid-plan idea, and this is only ever a
      // free workspace.
      overage: "never",
    },
  ],
})

/**
 * The tier as an assignment, or null for anybody who is not on the free plan.
 *
 * ⚠ NULL IS "NO CEILING", NOT "NO PLAN". The meter answers `unentitled` for a
 * null assignment, and `tierCeiling` reads that as "this workspace has no tier"
 * - which is exactly true of a paid workspace.
 */
export function tierAssignments(
  db: Database,
  { freePlanId, featureId }: { freePlanId: string; featureId: string },
): AssignmentStore {
  return {
    async find(tenantId) {
      const rows = (await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          select a.plan_id, a.anchor, t.tier
            from core.plan_assignments a
            left join core.sending_tiers t on t.tenant_id = a.tenant_id
           where a.tenant_id = ${tenantId}::uuid
           limit 1
        `),
      )) as unknown as {
        plan_id: string
        anchor: string | Date
        tier: SendingTier | null
      }[]
      const row = rows[0]
      // ⚠ THE FREE PLAN BY ID, NOT BY RANK. `plans.rank` defaults to 0, so a
      // custom plan written without one would read as free and a paying
      // customer would be capped at 3,000 a month.
      if (!row || row.plan_id !== freePlanId) return null
      return {
        tenantId,
        anchor: new Date(row.anchor),
        overageEnabled: false,
        plan: tierPlan(row.tier ?? DEFAULT_TIER, featureId),
      } satisfies Assignment
    },
  }
}

/** The meter that enforces tiers. Same ledger as the plan's meter. */
export function tierMeter(
  db: Database,
  opts: { freePlanId: string; featureId: string },
): Meter {
  return createMeter({
    assignments: tierAssignments(db, opts),
    usage: meterEventStore(db),
    levels: postgresLevels(db),
  })
}

export interface TierChange {
  tenantId: string
  tier: SendingTier
  source: "score" | "staff"
  /** Why, in words a reviewer and an appeal can read. Required. */
  reason: string
  /** The staff member's name, or `risk-score`. */
  setBy: string
  /**
   * ⚠ THE SCORE PASSES TRUE, AND IT IS CHECKED UNDER THE LOCK. A tier a person
   * set is a decision the score must not undo; checking `current()` first and
   * calling `set()` second would leave a window in which staff could set it
   * and the next hourly run overwrite it anyway (#170).
   */
  respectStaff?: boolean
}

export interface CurrentTier {
  tier: SendingTier
  /** `default` when nothing has moved it. */
  source: "default" | "score" | "staff"
  reason: string | null
  changedAt: Date | null
}

/**
 * Reading and moving a workspace's tier (#165).
 *
 * ⚠ `set` IS THE ONE DOOR, AND IT HAS TWO FUTURE CALLERS, NEITHER BUILT: the
 * risk score (#170), and staff overrides in the internal admin app (#217, not
 * built yet). Both come through here so the audit row is written in
 * the same transaction as the change - a tier moved without a record of who
 * and why cannot be defended in an appeal.
 */
export interface SendingTierStore {
  current(tenantId: string): Promise<CurrentTier>
  /**
   * Returns whether the tier moved. Setting the tier a row already holds
   * writes nothing.
   */
  set(
    change: TierChange,
  ): Promise<{ changed: boolean; from: SendingTier; refused?: "staff" }>
}

export function sendingTierStore(db: Database): SendingTierStore {
  return {
    async current(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            tier: sendingTiers.tier,
            source: sendingTiers.source,
            reason: sendingTiers.reason,
            changedAt: sendingTiers.changedAt,
          })
          .from(sendingTiers)
          .where(eq(sendingTiers.tenantId, tenantId))
          .limit(1),
      )
      return row
        ? {
            tier: row.tier,
            source: row.source as CurrentTier["source"],
            reason: row.reason,
            changedAt: row.changedAt,
          }
        : { tier: DEFAULT_TIER, source: "default", reason: null, changedAt: null }
    },

    async set(change) {
      if (!change.reason.trim()) throw new RangeError("a tier change needs a reason")
      return withTenant(db, change.tenantId, async (tx) => {
        // ⚠ `FOR UPDATE`, so two writers (the score and a person) cannot both
        // read the old tier and both write an audit row claiming to move from it.
        const [row] = await tx
          .select({ tier: sendingTiers.tier, source: sendingTiers.source })
          .from(sendingTiers)
          .where(eq(sendingTiers.tenantId, change.tenantId))
          .for("update")
          .limit(1)
        const from = row?.tier ?? DEFAULT_TIER
        if (change.respectStaff && row?.source === "staff") {
          return { changed: false, from, refused: "staff" as const }
        }
        if (from === change.tier && row) return { changed: false, from }

        const at = new Date()
        await tx
          .insert(sendingTiers)
          .values({
            tenantId: change.tenantId,
            tier: change.tier,
            source: change.source,
            reason: change.reason,
            setBy: change.setBy,
            changedAt: at,
          })
          .onConflictDoUpdate({
            target: sendingTiers.tenantId,
            set: {
              tier: change.tier,
              source: change.source,
              reason: change.reason,
              setBy: change.setBy,
              changedAt: at,
            },
          })
        // ⚠ A FIRST ROW THAT ONLY CONFIRMS THE DEFAULT IS AUDITED TOO. A person
        // pinning `normal` is a decision the score should see and respect, and
        // "every change is audited" has no exception for the quiet ones.
        await tx.insert(sendingTierEvents).values({
          tenantId: change.tenantId,
          fromTier: from,
          toTier: change.tier,
          source: change.source,
          reason: change.reason,
          setBy: change.setBy,
          changedAt: at,
        })
        return { changed: from !== change.tier, from }
      })
    },
  }
}
