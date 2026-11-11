import type { Context, Hono } from "hono"
import { mailboxAddressSchema } from "@repo/contracts"
import { can } from "../../console/roles.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired } from "./http.js"

/**
 * Workspace mailbox list and detail for the console (Step B5).
 *
 * ⚠ VISIBILITY IS ENFORCED ON THE SERVER. Owners and admins (`members:manage`,
 * `console/roles.ts`) see every mailbox in the workspace; everyone else sees
 * only their own. A member asking for another person's address gets 404, not
 * 403, so the response never reveals whether that address exists.
 *
 * ⚠ MOUNTED AFTER `mountMailboxStorage` in `routes/console.ts` so the static
 * `/mailboxes/storage` route matches before `/mailboxes/:address`.
 */

const NOT_FOUND = notFound("No such mailbox in this workspace.")

export function mountMailboxes(app: Hono, d: ConsoleDeps): void {
  const viewerOf = async (c: Context) => {
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    const isAdmin = d.roles
      ? await can(d.roles.store, tenantId, userId, "members:manage")
      : d.teamDomains
        ? await d.teamDomains.can(tenantId, userId, "members:manage")
        : undefined
    return { tenantId, userId, orgId, isAdmin }
  }

  const addressOf = (rawParam: string | undefined): string | null => {
    if (!rawParam) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(rawParam)
    } catch {
      return null
    }
    const parsed = mailboxAddressSchema.safeParse(decoded)
    return parsed.success ? parsed.data : null
  }

  /** Every mailbox in the workspace for an admin, or the caller's own for a member. */
  app.get("/mailboxes", async (c) => {
    if (!d.mailboxes) return c.json(notWired("Mailboxes"), 501)
    const viewer = await viewerOf(c)
    const rawLimit = c.req.query("limit")
    const limit = rawLimit !== undefined ? Number(rawLimit) : undefined
    const cursor = c.req.query("cursor")

    const page = await d.mailboxes.list(viewer, { limit, cursor })
    return c.json(page)
  })

  /** One mailbox's detail. 404 when absent or when a member asks for someone else's. */
  app.get("/mailboxes/:address", async (c) => {
    if (!d.mailboxes) return c.json(notWired("Mailboxes"), 501)
    const address = addressOf(c.req.param("address"))
    if (!address) return c.json(NOT_FOUND, 404)

    const viewer = await viewerOf(c)
    const mailbox = await d.mailboxes.get(viewer, address)
    return mailbox ? c.json(mailbox) : c.json(NOT_FOUND, 404)
  })
}
