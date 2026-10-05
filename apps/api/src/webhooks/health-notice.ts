import { eq } from "drizzle-orm"
import { renderWebhookHealth } from "@repo/emails"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import { withTenant, type Database } from "../db/client.js"
import { tenants } from "../db/core.js"
import type { HealthNotify } from "./health.js"

/**
 * The webhook health email (#284), to the workspace's owner.
 *
 * ⚠ THROUGH OUR OWN SYSTEM SENDER, like every notice we send as ourselves
 * (ses-status/notice.ts, risk/notice.ts): our coded sender and tenant, never
 * the workspace's own domain.
 */
export function healthNotice({
  db,
  clerk,
  sender,
  consoleUrl,
}: {
  db: Database
  clerk: {
    users: {
      getUser(
        id: string,
      ): Promise<{ primaryEmailAddress?: { emailAddress: string } | null }>
    }
  }
  sender: AuthEmailSender
  consoleUrl: string
}): HealthNotify {
  return async (tenantId, summary, idempotencyKey) => {
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

    const rendered = await renderWebhookHealth({
      workspace: workspace.name,
      worst: summary.worst,
      lines: summary.lines.map((line) => ({
        url: line.url,
        state: line.state,
        reason: line.reason,
        since: formatWhen(line.since),
      })),
      url: `${consoleUrl.replace(/\/$/, "")}/webhooks`,
    })
    await sender.send({ to, ...rendered, idempotencyKey })
  }
}

/** "6 October 2026, 10:40 UTC": unambiguous wherever the owner reads it. */
export const formatWhen = (at: Date): string =>
  `${at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })}, ${at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`
