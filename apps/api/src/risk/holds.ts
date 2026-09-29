import { and, eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { riskAssessments, sendingHoldEvents, sendingHolds } from "../db/core.js"
import type { Category } from "./types.js"

/**
 * Holding a workspace's sending, and releasing it (#170).
 *
 * ⚠ THE ONE DOOR, LIKE `sendingTierStore.set`. The score, the admin script and
 * the future admin app (#217) all come through here, so the audit row is
 * written in the same transaction as the hold - a hold nobody can explain
 * cannot be defended in an appeal.
 *
 * ⚠ A HOLD CANCELS WHAT IS ALREADY QUEUED, IN THE SAME TRANSACTION. Mail
 * accepted a minute before a critical score is most likely the abuse itself;
 * letting it drain would make the hold a formality. Canceled, not failed: it
 * was not attempted, and the customer can resend it after a release. The
 * worker re-checks at claim for anything in flight.
 */
export const REVIEW_WITHIN_HOURS = 24
export const DEFAULT_PAUSE_DAYS = 14

export interface HoldInput {
  tenantId: string
  source: "score" | "staff"
  reason: string
  category: Category
  setBy: string
  /** `all` also stops mailboxes, and only staff may set it. */
  scope?: "api" | "all"
}

export interface CurrentHold {
  scope: "api" | "all"
  source: string
  reason: string
  category: string
  setBy: string
  heldAt: Date
  reviewDueAt: Date
  reviewAlertedAt: Date | null
  notifiedAt: Date | null
  canceledMessages: number
}

export interface HoldStore {
  current(tenantId: string): Promise<CurrentHold | null>
  /** Null when already held; the existing hold stands and nothing is written. */
  hold(input: HoldInput): Promise<{ canceled: number } | null>
  /**
   * Releases a hold. ⚠ IT ALSO PAUSES THE SCORE'S HAND for `pauseDays`, so the
   * next hourly run does not re-hold on the very evidence a person just
   * weighed and dismissed.
   */
  release(input: {
    tenantId: string
    setBy: string
    reason: string
    outcome: "false_positive" | "upheld"
    pauseDays?: number
  }): Promise<boolean>
  markNotified(tenantId: string): Promise<void>
  markReviewAlerted(tenantId: string): Promise<void>
}

export function holdStore(db: Database, now: () => Date = () => new Date()): HoldStore {
  const h = sendingHolds
  return {
    async current(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx.select().from(h).where(eq(h.tenantId, tenantId)).limit(1),
      )
      return row
        ? {
            scope: row.scope,
            source: row.source,
            reason: row.reason,
            category: row.category,
            setBy: row.setBy,
            heldAt: row.heldAt,
            reviewDueAt: row.reviewDueAt,
            reviewAlertedAt: row.reviewAlertedAt,
            notifiedAt: row.notifiedAt,
            canceledMessages: row.canceledMessages,
          }
        : null
    },

    async hold(input) {
      if (!input.reason.trim()) throw new RangeError("a hold needs a reason")
      if (input.scope === "all" && input.source !== "staff") {
        throw new RangeError("only staff may hold a workspace's mailboxes")
      }
      const at = now()
      return withTenant(db, input.tenantId, async (tx) => {
        const inserted = await tx
          .insert(h)
          .values({
            tenantId: input.tenantId,
            scope: input.scope ?? "api",
            source: input.source,
            reason: input.reason,
            category: input.category,
            setBy: input.setBy,
            heldAt: at,
            reviewDueAt: new Date(at.getTime() + REVIEW_WITHIN_HOURS * 3_600_000),
          })
          .onConflictDoNothing()
          .returning({ tenantId: h.tenantId })
        if (inserted.length === 0) return null

        const canceled = (await tx.execute(sql`
          update core.messages
             set status = 'canceled',
                 last_error = ${`held: ${input.category}`}
           where tenant_id = ${input.tenantId}::uuid
             and status = 'queued'
          returning id
        `)) as unknown as unknown[]

        await tx
          .update(h)
          .set({ canceledMessages: canceled.length })
          .where(eq(h.tenantId, input.tenantId))
        await tx.insert(sendingHoldEvents).values({
          tenantId: input.tenantId,
          action: "hold",
          scope: input.scope ?? "api",
          source: input.source,
          reason: input.reason,
          category: input.category,
          setBy: input.setBy,
          occurredAt: at,
        })
        return { canceled: canceled.length }
      })
    },

    async release({
      tenantId,
      setBy,
      reason,
      outcome,
      pauseDays = DEFAULT_PAUSE_DAYS,
    }) {
      if (!reason.trim()) throw new RangeError("a release needs a reason")
      const at = now()
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .delete(h)
          .where(eq(h.tenantId, tenantId))
          .returning({ scope: h.scope, category: h.category })
        if (!row) return false
        await tx.insert(sendingHoldEvents).values({
          tenantId,
          action: "release",
          scope: row.scope,
          source: "staff",
          reason,
          category: row.category,
          setBy,
          outcome,
          occurredAt: at,
        })
        await tx
          .update(riskAssessments)
          .set({
            clearedAt: at,
            autoActionsPausedUntil: new Date(at.getTime() + pauseDays * 86_400_000),
          })
          .where(eq(riskAssessments.tenantId, tenantId))
        return true
      })
    },

    async markNotified(tenantId) {
      await withTenant(db, tenantId, (tx) =>
        tx.update(h).set({ notifiedAt: now() }).where(eq(h.tenantId, tenantId)),
      )
    },

    async markReviewAlerted(tenantId) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(h)
          .set({ reviewAlertedAt: now() })
          .where(and(eq(h.tenantId, tenantId))),
      )
    },
  }
}
