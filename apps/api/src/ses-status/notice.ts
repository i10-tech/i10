import { eq } from "drizzle-orm"
import { renderSendingStatus } from "@repo/emails"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import { withTenant, type Database } from "../db/client.js"
import { tenants } from "../db/core.js"
import type { OwnerNotice } from "./service.js"

/**
 * Emails a workspace's owner that SES paused or resumed its sending (#157).
 *
 * ⚠ THE OWNER, NOT EVERY MEMBER. `core.tenants.owner_clerk_user_id` is the one
 * person accountable for the workspace; mailing a whole organisation about its
 * bounce rate turns a fix into a thread. The console banner reaches everyone
 * else who signs in.
 *
 * ⚠ THEIR PRIMARY ADDRESS, READ FROM CLERK AT SEND TIME. A copy of it here
 * would be stale the day somebody changes it - and this is the one email they
 * most need to receive.
 */
export function ownerNotice({
  db,
  clerk,
  sender,
  consoleUrl,
}: {
  db: Database
  clerk: {
    users: {
      getUser(id: string): Promise<{
        primaryEmailAddress?: { emailAddress: string } | null
      }>
    }
  }
  sender: AuthEmailSender
  consoleUrl: string
}): OwnerNotice {
  return {
    async send({ tenantId, paused, cause, key }) {
      const [workspace] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: tenants.name, owner: tenants.ownerClerkUserId })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      )
      if (!workspace) throw new Error(`no workspace ${tenantId}`)

      const to = (await clerk.users.getUser(workspace.owner)).primaryEmailAddress
        ?.emailAddress
      if (!to) throw new Error(`the owner of ${tenantId} has no primary email address`)

      const rendered = await renderSendingStatus({
        paused,
        workspace: workspace.name,
        cause,
        url: consoleUrl,
      })
      // ⚠ THE KEY NAMES THE CHANGE, so the event and the poll reporting the
      // same pause send one email between them.
      await sender.send({ to, ...rendered, idempotencyKey: key })
    },
  }
}
