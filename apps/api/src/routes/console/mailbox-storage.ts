import type { Hono } from "hono"
import { mailboxAddressSchema, setMailboxStorageSchema } from "@repo/contracts"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import type { MailboxStorageRow } from "../../mailboxes/allocation.js"

/**
 * Splitting the workspace's mailbox storage across its inboxes (#379).
 *
 * ⚠ OWNERS AND ADMINS ONLY, AND THE CHECK IS HERE RATHER THAN IN THE CONSOLE.
 * An allocation takes from a pool the whole workspace shares, so the person who
 * will use an inbox must not be the one who sizes it: that is a member taking
 * the pool. It asks our roles table for `members:manage` - the one the team and
 * invitation routes ask, which owners and admins hold and members do not - and
 * `/mailboxes`, the route a member reaches, has no storage field at all.
 *
 * ⚠ AND IT TARGETS A MAILBOX OF THE CALLER'S WORKSPACE, never one named by a
 * body. The tenant is the verified session's; the address in the path is looked
 * up under it, so an address in another workspace is a 404 like any other
 * address that is not here.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const asMailbox = (row: MailboxStorageRow) => ({
  address: row.address,
  display_name: row.display_name,
  storage_allocated: row.allocation,
})

export function mountMailboxStorage(app: Hono, d: ConsoleDeps): void {
  // ⚠ NO ORGANIZATION IS "NOT AN ADMIN", as in the members routes: without one
  // there is no role to ask about, and a guess is not a check.
  const isAdmin = async (tenantId: string, userId: string, orgId: string | undefined) =>
    Boolean(
      orgId &&
      d.teamDomains &&
      (await d.teamDomains.can(tenantId, userId, "members:manage")),
    )

  /** The pool and every inbox in it, with what each has and uses. */
  app.get("/mailboxes/storage", async (c) => {
    if (!d.mailboxStorage) return c.json(notWired("Mailbox storage"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    if (!(await isAdmin(tenantId, userId, orgId)))
      return c.json(forbidden("Only an admin can see the storage pool."), 403)

    const { pool, mailboxes } = await d.mailboxStorage.overview(tenantId)
    return c.json({ pool, data: mailboxes.map(asMailbox) })
  })

  /**
   * Gives one inbox its share. `null` removes a cap, which only pay as you go
   * allows; a prepaid plan needs a number for every inbox.
   */
  app.put("/mailboxes/:address/storage", async (c) => {
    if (!d.mailboxStorage) return c.json(notWired("Mailbox storage"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    if (!(await isAdmin(tenantId, userId, orgId)))
      return c.json(forbidden("Only an admin can allocate storage."), 403)

    const parsed = setMailboxStorageSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(
          parsed.error.issues[0]?.message ??
            "`storage_allocation` must be a positive whole number of bytes, or null.",
        ),
        422,
      )
    }

    // ⚠ A PATH THAT IS NOT AN ADDRESS IS A 404 LIKE ANY ADDRESS THAT IS NOT HERE,
    // and a malformed escape must not become a 500.
    let raw: string
    try {
      raw = decodeURIComponent(c.req.param("address"))
    } catch {
      return c.json(notFound("No such mailbox in this workspace."), 404)
    }
    const parsedAddress = mailboxAddressSchema.safeParse(raw)
    if (!parsedAddress.success) {
      return c.json(notFound("No such mailbox in this workspace."), 404)
    }
    const address = parsedAddress.data
    const outcome = await d.mailboxStorage.allocate({
      tenantId,
      address,
      bytes: parsed.data.storage_allocation,
    })

    switch (outcome.status) {
      case "ok": {
        const { mailboxes } = await d.mailboxStorage.overview(tenantId)
        const row = mailboxes.find((m) => m.address.toLowerCase() === address)
        return c.json({ mailbox: row ? asMailbox(row) : null, quota: outcome.quota })
      }

      case "not_found":
        return c.json(notFound("No such mailbox in this workspace."), 404)

      case "required":
        return c.json(
          validation(
            "Your plan's storage is a pool you split across inboxes, so every " +
              "inbox needs an amount.",
          ),
          422,
        )

      // ⚠ 403 WITH THE SAME NAME THE MAILBOX AND DOMAIN LIMITS USE, NOT 429.
      // No amount of waiting makes room; the fix is a smaller share elsewhere or
      // a bigger plan.
      case "over_pool":
        return c.json(
          {
            statusCode: 403,
            name: "plan_limit_exceeded" as const,
            message:
              `That is more than is left in the pool: ${outcome.remaining} of ` +
              `${outcome.total} bytes.`,
            remaining: outcome.remaining,
            total: outcome.total,
          },
          403,
        )
    }
  })
}
