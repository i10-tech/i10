import { eq } from "drizzle-orm"
import {
  renderSecurityAlert,
  renderSendingHeld,
  renderTemplateReview,
} from "@repo/emails"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import { withTenant, type Database } from "../db/client.js"
import { tenants } from "../db/core.js"
import type { HoldNotice } from "./act.js"
import { CATEGORY_TEXT } from "./types.js"

/**
 * The emails the risk engine sends (#170): a hold to the workspace's owner,
 * a security notice to a person.
 *
 * ⚠ THROUGH OUR OWN SYSTEM SENDER, as the SES pause email is (ses-status/
 * notice.ts) - our tenant, our coded sender, never the held workspace's own
 * sending, which is exactly what just stopped.
 *
 * ⚠ IDEMPOTENCY KEYS NAME THE EVENT, so a retried run or a second trigger for
 * the same hold sends one email.
 */
interface ClerkUsers {
  users: {
    getUser(
      id: string,
    ): Promise<{ primaryEmailAddress?: { emailAddress: string } | null }>
  }
}

/** A decision on a submitted template (#222), for the workspace's owner. */
export interface TemplateDecisionNotice {
  tenantId: string
  templateId: string
  template: string
  decision: "approved" | "rejected" | "revoked"
  reason: string | null
}

export function riskNotices({
  db,
  clerk,
  sender,
  consoleUrl,
}: {
  db: Database
  clerk: ClerkUsers
  sender: AuthEmailSender
  consoleUrl: string
}): HoldNotice & {
  security(userId: string, detail: Record<string, unknown>): Promise<void>
  keySpread(tenantId: string): Promise<void>
  templateDecision(input: TemplateDecisionNotice): Promise<void>
} {
  const emailOf = async (userId: string) => {
    const to = (await clerk.users.getUser(userId)).primaryEmailAddress?.emailAddress
    if (!to) throw new Error(`user ${userId} has no primary email address`)
    return to
  }
  const workspace = async (tenantId: string) => {
    const [row] = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ name: tenants.name, owner: tenants.ownerClerkUserId })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    )
    if (!row) throw new Error(`no workspace ${tenantId}`)
    return row
  }

  return {
    async held({ tenantId, category, canceled }) {
      const w = await workspace(tenantId)
      const rendered = await renderSendingHeld({
        state: "held",
        workspace: w.name,
        why: CATEGORY_TEXT[category],
        canceled,
        url: consoleUrl,
      })
      await sender.send({
        to: await emailOf(w.owner),
        ...rendered,
        idempotencyKey: `risk-hold:${tenantId}:${new Date().toISOString().slice(0, 13)}`,
      })
    },

    async security(userId, detail) {
      const rendered = await renderSecurityAlert({
        kind: "impossible_travel",
        from: typeof detail.from === "string" ? detail.from : null,
        to: typeof detail.to === "string" ? detail.to : null,
        url: consoleUrl,
      })
      await sender.send({
        to: await emailOf(userId),
        ...rendered,
        idempotencyKey: `risk-takeover:${userId}:${new Date().toISOString().slice(0, 10)}`,
      })
    },

    async templateDecision({ tenantId, templateId, template, decision, reason }) {
      const w = await workspace(tenantId)
      const rendered = await renderTemplateReview({
        decision,
        workspace: w.name,
        template,
        reason,
        url: `${consoleUrl.replace(/\/$/, "")}/templates`,
      })
      await sender.send({
        to: await emailOf(w.owner),
        ...rendered,
        // ⚠ ONE EMAIL PER DECISION: a template is decided once and revoked
        // once, so the id and the decision name the event.
        idempotencyKey: `risk-template:${templateId}:${decision}`,
      })
    },

    async keySpread(tenantId) {
      const w = await workspace(tenantId)
      const rendered = await renderSecurityAlert({
        kind: "key_spread",
        url: consoleUrl,
      })
      await sender.send({
        to: await emailOf(w.owner),
        ...rendered,
        idempotencyKey: `risk-key-spread:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
      })
    },
  }
}
