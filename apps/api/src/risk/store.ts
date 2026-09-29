import { desc, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { riskAssessmentEvents, riskAssessments } from "../db/core.js"
import type { PreviousState } from "./decide.js"
import type { Assessment, Band } from "./types.js"

/**
 * Where assessments live (#170): the current one per workspace, and the
 * history of every one that mattered.
 *
 * ⚠ AN EVENT IS WRITTEN WHEN SOMETHING MOVED, NOT EVERY HOUR. A band change, a
 * swing of ten points or more, or an action - the three things an appeal or a
 * staff review asks about. An hourly row per workspace would bury them.
 */
export const EVENT_SWING = 10

export interface StoredAssessment extends PreviousState {
  score: number
  contributions: Assessment["contributions"]
  rulesetVersion: number
  sesPolicySetAt: Date | null
  alertedAt: Date | null
  computedAt: Date
  modelScore: number | null
}

export interface AssessmentStore {
  current(tenantId: string): Promise<StoredAssessment | null>
  save(input: {
    tenantId: string
    assessment: Assessment
    bandSince: Date
    modelScore: number | null
    previous: { band: Band; score: number } | null
    actions: string[]
    trigger: string
    at: Date
    /** False writes the current row only; the caller records the event later. */
    writeEvent?: boolean
  }): Promise<{ event: boolean }>
  setSesPolicy(tenantId: string, policy: string, at: Date): Promise<void>
  markAlerted(tenantId: string, at: Date): Promise<void>
  /**
   * Staff's hand on the score: pause automatic actions until a date.
   * ⚠ AUDITED: the who and why become an event row, like every other action.
   */
  pause(
    tenantId: string,
    until: Date,
    at: Date,
    audit?: { by: string; reason: string },
  ): Promise<boolean>
  history(
    tenantId: string,
    limit: number,
  ): Promise<(typeof riskAssessmentEvents.$inferSelect)[]>
}

export function assessmentStore(db: Database): AssessmentStore {
  const r = riskAssessments
  return {
    async current(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx.select().from(r).where(eq(r.tenantId, tenantId)).limit(1),
      )
      if (!row) return null
      return {
        band: row.band,
        bandSince: row.bandSince,
        autoActionsPausedUntil: row.autoActionsPausedUntil,
        clearedAt: row.clearedAt,
        sesPolicy: row.sesPolicy,
        score: row.score,
        contributions: row.contributions as Assessment["contributions"],
        rulesetVersion: row.rulesetVersion,
        sesPolicySetAt: row.sesPolicySetAt,
        alertedAt: row.alertedAt,
        computedAt: row.computedAt,
        modelScore: row.modelScore,
      }
    },

    async save({
      tenantId,
      assessment,
      bandSince,
      modelScore,
      previous,
      actions,
      trigger,
      at,
      writeEvent = true,
    }) {
      const moved =
        writeEvent &&
        (!previous ||
          previous.band !== assessment.band ||
          Math.abs(previous.score - assessment.score) >= EVENT_SWING ||
          actions.length > 0)
      await withTenant(db, tenantId, async (tx) => {
        const values = {
          score: assessment.score,
          band: assessment.band,
          rulesetVersion: assessment.rulesetVersion,
          contributions: assessment.contributions,
          modelScore,
          bandSince,
          computedAt: at,
        }
        await tx
          .insert(r)
          .values({ tenantId, ...values })
          .onConflictDoUpdate({ target: r.tenantId, set: values })
        if (moved) {
          await tx.insert(riskAssessmentEvents).values({
            tenantId,
            score: assessment.score,
            band: assessment.band,
            fromBand: previous?.band ?? null,
            rulesetVersion: assessment.rulesetVersion,
            contributions: assessment.contributions,
            actions,
            trigger,
            occurredAt: at,
          })
        }
      })
      return { event: moved }
    },

    async setSesPolicy(tenantId, policy, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(r)
          .set({ sesPolicy: policy, sesPolicySetAt: at })
          .where(eq(r.tenantId, tenantId)),
      )
    },

    async markAlerted(tenantId, at) {
      await withTenant(db, tenantId, (tx) =>
        tx.update(r).set({ alertedAt: at }).where(eq(r.tenantId, tenantId)),
      )
    },

    async pause(tenantId, until, at, audit) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(r)
          .set({ autoActionsPausedUntil: until, clearedAt: at })
          .where(eq(r.tenantId, tenantId))
          .returning()
        if (!row) return false
        if (audit) {
          await tx.insert(riskAssessmentEvents).values({
            tenantId,
            score: row.score,
            band: row.band,
            fromBand: row.band,
            rulesetVersion: row.rulesetVersion,
            contributions: row.contributions,
            actions: [
              `pin:until=${until.toISOString()}`,
              `by:${audit.by}`,
              `reason:${audit.reason}`,
            ],
            trigger: "staff",
            occurredAt: at,
          })
        }
        return true
      })
    },

    async history(tenantId, limit) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(riskAssessmentEvents)
          .where(eq(riskAssessmentEvents.tenantId, tenantId))
          .orderBy(desc(riskAssessmentEvents.occurredAt))
          .limit(limit),
      )
    },
  }
}
