import { eq } from "drizzle-orm"
import { mailboxCreationModeSchema, type MailboxCreationMode } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { events, workspaceSettings } from "../db/identity.js"
import type { MailboxProvisioning } from "./provision.js"

/**
 * Who creates mailboxes in a workspace, kept on its `workspace_settings` row.
 *
 * ⚠ NO ROW IS `admins`, AND SO IS ANYTHING THE COLUMN HOLDS THAT WE DO NOT
 * RECOGNISE. The CHECK constraint makes the second impossible today; reading it
 * through the schema means a future value an older pod does not know degrades to
 * the strictest mode instead of to whichever branch an `if` happened to fall into.
 */

export const DEFAULT_CREATION_MODE: MailboxCreationMode = "admins"

/** What the console's mailbox-creation routes need, wired once in `index.ts`. */
export interface MailboxAdmin {
  provisioning: Pick<MailboxProvisioning, "create">
  settings: MailboxCreationStore
  /** An owner or admin of the workspace. */
  isAdmin(tenantId: string, userId: string): Promise<boolean>
  /** A member of the workspace, which is all the target of a creation has to be. */
  isMember(tenantId: string, userId: string): Promise<boolean>
}

export interface MailboxCreationStore {
  get(tenantId: string): Promise<MailboxCreationMode>
  /** Saves the mode, with its audit row in the same transaction. */
  set(
    tenantId: string,
    actorUserId: string,
    mode: MailboxCreationMode,
  ): Promise<{ before: MailboxCreationMode; after: MailboxCreationMode }>
}

const read = (value: string | undefined): MailboxCreationMode =>
  mailboxCreationModeSchema.catch(DEFAULT_CREATION_MODE).parse(value)

export function mailboxCreationStore(db: Database): MailboxCreationStore {
  return {
    async get(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ mode: workspaceSettings.mailboxCreation })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1),
      )
      return read(row?.mode)
    },

    async set(tenantId, actorUserId, mode) {
      return withTenant(db, tenantId, async (tx) => {
        // The row under a lock, made with its defaults first when missing, as
        // identity/workspace-policy-store.ts does for its own columns.
        await tx.insert(workspaceSettings).values({ tenantId }).onConflictDoNothing()
        const [current] = await tx
          .select({ mode: workspaceSettings.mailboxCreation })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .for("update")
          .limit(1)
        const before = read(current?.mode)

        await tx
          .update(workspaceSettings)
          .set({ mailboxCreation: mode, updatedBy: actorUserId, updatedAt: new Date() })
          .where(eq(workspaceSettings.tenantId, tenantId))
        await tx.insert(events).values({
          tenantId,
          type: "mailbox_creation.updated",
          actorUserId,
          data: { before, after: mode },
        })
        return { before, after: mode }
      })
    },
  }
}
