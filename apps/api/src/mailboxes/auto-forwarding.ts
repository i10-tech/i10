import { eq } from "drizzle-orm"
import { autoForwardingModeSchema, type AutoForwardingMode } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { events, workspaceSettings } from "../db/identity.js"

/**
 * Per-workspace automatic forwarding policy (#526), stored on
 * `identity.workspace_settings.auto_forwarding` and enforced in Stalwart by
 * `core.auto_forward_allowed`.
 *
 * ⚠ NO ROW IS `workspace`, AND SO IS ANY UNKNOWN VALUE. Falling back to the
 * default keeps older pods safe if a future mode is ever added.
 */

export const DEFAULT_AUTO_FORWARDING_MODE: AutoForwardingMode = "workspace"

export interface AutoForwardingStore {
  get(tenantId: string): Promise<AutoForwardingMode>
  /** Saves the mode and writes `workspace.auto_forwarding_changed` in one transaction. */
  set(
    tenantId: string,
    actorUserId: string,
    mode: AutoForwardingMode,
  ): Promise<{ before: AutoForwardingMode; after: AutoForwardingMode }>
}

/** What the console's automatic-forwarding routes need, wired once in `index.ts`. */
export interface AutoForwardingConsoleDeps {
  store: AutoForwardingStore
  /** An owner or admin of the workspace (`members:manage`). */
  isAdmin(tenantId: string, userId: string): Promise<boolean>
}

const read = (value: string | undefined): AutoForwardingMode =>
  autoForwardingModeSchema.catch(DEFAULT_AUTO_FORWARDING_MODE).parse(value)

export function autoForwardingStore(db: Database): AutoForwardingStore {
  return {
    async get(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ mode: workspaceSettings.autoForwarding })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1),
      )
      return read(row?.mode)
    },

    async set(tenantId, actorUserId, mode) {
      return withTenant(db, tenantId, async (tx) => {
        await tx.insert(workspaceSettings).values({ tenantId }).onConflictDoNothing()
        const [current] = await tx
          .select({ mode: workspaceSettings.autoForwarding })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .for("update")
          .limit(1)
        const before = read(current?.mode)

        await tx
          .update(workspaceSettings)
          .set({ autoForwarding: mode, updatedBy: actorUserId, updatedAt: new Date() })
          .where(eq(workspaceSettings.tenantId, tenantId))

        await tx.insert(events).values({
          tenantId,
          type: "workspace.auto_forwarding_changed",
          actorUserId,
          data: { before, after: mode },
        })
        return { before, after: mode }
      })
    },
  }
}
