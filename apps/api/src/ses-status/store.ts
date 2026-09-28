import { and, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { sesTenantStatus, sesTenantStatusEvents } from "../db/core.js"
import type { SesSendingStatus } from "./event.js"

export interface StatusChange {
  tenantId: string
  status: SesSendingStatus
  cause: string | null
  origin: string | null
  changedAt: Date
  /** `event` (EventBridge) or `poll` (the daily re-check). */
  source: "event" | "poll"
}

export interface CurrentStatus {
  status: SesSendingStatus
  cause: string | null
  origin: string | null
  changedAt: Date
  notifiedAt: Date | null
}

/**
 * Where a workspace's SES sending status lives (#157).
 *
 * ⚠ EVERY CALL IS INSIDE `withTenant` FOR THE WORKSPACE THE TENANT NAME NAMES.
 * The SES tenant name is `i10-<workspace id>`, so the webhook and the poll know
 * whose row they are writing without a cross-tenant read or a definer function.
 */
export interface SesStatusStore {
  /**
   * Records a change. `previous` is the status before it - `enabled` when there
   * was no row - and `changed` says whether the current status moved.
   *
   * ⚠ AN OLDER REPORT NEVER OVERWRITES A NEWER ONE. The event and the poll can
   * arrive in either order, and SNS retries late; the current row only moves
   * forward in SES's time. The history keeps every report regardless.
   */
  record(
    change: StatusChange,
  ): Promise<{ changed: boolean; previous: SesSendingStatus }>
  current(tenantId: string): Promise<CurrentStatus | null>
  markNotified(tenantId: string, changedAt: Date): Promise<void>
}

export function sesStatusStore(db: Database): SesStatusStore {
  return {
    async record(change) {
      return withTenant(db, change.tenantId, async (tx) => {
        await tx
          .insert(sesTenantStatusEvents)
          .values({
            tenantId: change.tenantId,
            status: change.status,
            cause: change.cause,
            origin: change.origin,
            changedAt: change.changedAt,
            source: change.source,
          })
          .onConflictDoNothing()

        const [row] = await tx
          .select({
            status: sesTenantStatus.status,
            changedAt: sesTenantStatus.changedAt,
          })
          .from(sesTenantStatus)
          .where(eq(sesTenantStatus.tenantId, change.tenantId))
          .limit(1)

        const previous: SesSendingStatus = row?.status ?? "enabled"
        if (row && row.changedAt.getTime() >= change.changedAt.getTime()) {
          return { changed: false, previous }
        }
        // ⚠ NO ROW AND STILL ENABLED IS NOT A CHANGE. "No row means enabled",
        // so writing one would only make every workspace look as if SES had
        // said something about it.
        if (!row && change.status === "enabled") return { changed: false, previous }

        const values = {
          status: change.status,
          cause: change.cause,
          origin: change.origin,
          changedAt: change.changedAt,
          // A new status has not been told to anybody yet.
          notifiedAt: row && row.status === change.status ? undefined : null,
          updatedAt: new Date(),
        }
        await tx
          .insert(sesTenantStatus)
          .values({ tenantId: change.tenantId, ...values, notifiedAt: null })
          .onConflictDoUpdate({ target: sesTenantStatus.tenantId, set: values })

        return { changed: previous !== change.status, previous }
      })
    },

    async current(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            status: sesTenantStatus.status,
            cause: sesTenantStatus.cause,
            origin: sesTenantStatus.origin,
            changedAt: sesTenantStatus.changedAt,
            notifiedAt: sesTenantStatus.notifiedAt,
          })
          .from(sesTenantStatus)
          .where(eq(sesTenantStatus.tenantId, tenantId))
          .limit(1),
      )
      return row ?? null
    },

    async markNotified(tenantId, changedAt) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(sesTenantStatus)
          .set({ notifiedAt: new Date() })
          .where(
            and(
              eq(sesTenantStatus.tenantId, tenantId),
              eq(sesTenantStatus.changedAt, changedAt),
            ),
          ),
      )
    },
  }
}
