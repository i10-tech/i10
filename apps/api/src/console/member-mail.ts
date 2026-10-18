import { renderJoinAccepted, renderMemberCapacity } from "@repo/emails"
import type { AuthEmailSender } from "../auth-email/deliver.js"
import type { MemberMail } from "./members.js"

/**
 * The member emails (#327) - the capacity alerts and "you're in" - through
 * our own system sender, like every notice we send as ourselves: our coded
 * sender and tenant, never the workspace's own domain, never Clerk's.
 *
 * ⚠ ONE SEND PER ADMIN, each with its own idempotency key, so a retry after
 * a partial failure only sends what is missing.
 */
export function memberMail({
  sender,
  consoleUrl,
}: {
  sender: AuthEmailSender
  consoleUrl: string
}): MemberMail {
  const base = consoleUrl.replace(/\/$/, "")
  return {
    async capacity(input) {
      const rendered = await renderMemberCapacity({
        workspace: input.workspace,
        level: input.level,
        members: input.members,
        limit: input.limit,
        url: `${base}/settings/team`,
      })
      for (const to of input.to) {
        await sender.send({
          to,
          ...rendered,
          idempotencyKey: `${input.idempotencyKey}:${to.toLowerCase()}`,
        })
      }
    },
    async accepted(input) {
      const rendered = await renderJoinAccepted({
        workspace: input.workspace,
        waited: input.waited,
        url: base,
      })
      await sender.send({
        to: input.to,
        ...rendered,
        idempotencyKey: input.idempotencyKey,
      })
    },
  }
}
