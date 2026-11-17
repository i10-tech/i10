import type { Context, Hono } from "hono"
import {
  MAILBOX_ALIAS_LIMIT,
  addMailboxAliasSchema,
  mailboxAddressSchema,
  type MailboxAlias,
} from "@repo/contracts"
import type { AliasAddOutcome, AliasRow } from "../../mailboxes/aliases.js"
import { freshAuthRefusal } from "../../middleware/session.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * The addresses that deliver to one mailbox (B8).
 *
 *   GET    /mailboxes/:address/aliases           the aliases; a member sees their own mailbox's
 *   POST   /mailboxes/:address/aliases           add one, on any domain the workspace hosts (step-up)
 *   DELETE /mailboxes/:address/aliases/:alias    remove one the console added (step-up)
 *
 * ⚠ THE ORDER IS THE LIFECYCLE ROUTES': wired, then role, then step-up, then the
 * address in the path, then the body, then the target. A member is refused (403)
 * before they are asked to re-authenticate for something they will never be
 * allowed, and nobody learns anything about the body or the mailbox before proving
 * they may ask. The list is the exception: it is read only, so a member may ask
 * and the answer for somebody else's mailbox is the one for a mailbox that does
 * not exist.
 *
 * ⚠ MOUNTED BEFORE `mountMailboxes`, which owns `/mailboxes/:address`; these paths
 * are longer, so there is no clash, but the creation-mode route must still come
 * first and `mountMailboxAdmin` is mounted ahead of this.
 */

const NO_MAILBOX = notFound("No such mailbox in this workspace.")
const NO_ALIAS = notFound("That address is not an alias of this mailbox.")

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const conflict = (name: string, message: string) =>
  ({ statusCode: 409, name, message }) as const

const ADD_REFUSALS: Record<
  Exclude<AliasAddOutcome["status"], "added" | "not_found">,
  { statusCode: 409 | 422; name: string; message: string }
> = {
  deleting: conflict(
    "mailbox_deleting",
    "That mailbox is being deleted. Restore it first, or add the alias to another mailbox.",
  ),
  // ⚠ ANOTHER WORKSPACE'S DOMAIN READS EXACTLY LIKE ONE NOBODY HOSTS, so an admin
  // cannot learn which of their neighbours' domains are live.
  domain_not_hosted: {
    statusCode: 422,
    name: "validation_error",
    message:
      "This workspace does not host mailboxes on that domain. Turn on mailboxes for the domain first.",
  },
  taken: conflict("alias_taken", "That address is already taken."),
  limit: conflict(
    "alias_limit_reached",
    `A mailbox can have at most ${MAILBOX_ALIAS_LIMIT} aliases added here.`,
  ),
}

const view = (row: AliasRow): MailboxAlias => ({
  object: "mailbox_alias",
  address: row.address,
  source: row.source,
  removable: row.source === "console",
})

const decode = (raw: string | undefined): string | null => {
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

export function mountMailboxAliases(app: Hono, d: ConsoleDeps): void {
  const answer = (c: Context, rows: AliasRow[], status: 200 | 201 = 200) =>
    c.json({ data: rows.map(view), limit: MAILBOX_ALIAS_LIMIT }, status)

  /** The mutations' shared opening: wired, role, step-up, then the mailbox in the path. */
  const mutation = async (c: Context) => {
    const service = d.mailboxAliases
    if (!service) return { refused: c.json(notWired("Mailbox aliases"), 501) } as const
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    if (!(await service.isAdmin(tenantId, userId))) {
      return {
        refused: c.json(forbidden("Only an owner or admin can change aliases."), 403),
      } as const
    }
    const stepUp = await freshAuthRefusal(c)
    if (stepUp) return { refused: stepUp } as const
    const parsed = mailboxAddressSchema.safeParse(decode(c.req.param("address")) ?? "")
    if (!parsed.success) return { refused: c.json(NO_MAILBOX, 404) } as const
    return { service, tenantId, userId, address: parsed.data } as const
  }

  app.get("/mailboxes/:address/aliases", async (c) => {
    const service = d.mailboxAliases
    if (!service) return c.json(notWired("Mailbox aliases"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const parsed = mailboxAddressSchema.safeParse(decode(c.req.param("address")) ?? "")
    if (!parsed.success) return c.json(NO_MAILBOX, 404)

    const isAdmin = await service.isAdmin(tenantId, userId)
    const done = await service.list({ tenantId, userId, isAdmin }, parsed.data)
    return done.status === "ok" ? answer(c, done.aliases) : c.json(NO_MAILBOX, 404)
  })

  app.post("/mailboxes/:address/aliases", async (c) => {
    const ready = await mutation(c)
    if ("refused" in ready) return ready.refused
    const parsed = addMailboxAliasSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid request."),
        422,
      )
    }
    const done = await ready.service.add({
      tenantId: ready.tenantId,
      address: ready.address,
      alias: parsed.data.address,
      actorId: ready.userId,
    })
    if (done.status === "not_found") return c.json(NO_MAILBOX, 404)
    if (done.status !== "added") {
      const refusal = ADD_REFUSALS[done.status]
      return c.json(refusal, refusal.statusCode)
    }
    return answer(c, done.aliases, 201)
  })

  app.delete("/mailboxes/:address/aliases/:alias", async (c) => {
    const ready = await mutation(c)
    if ("refused" in ready) return ready.refused
    const alias = mailboxAddressSchema.safeParse(decode(c.req.param("alias")) ?? "")
    if (!alias.success) return c.json(NO_ALIAS, 404)

    const done = await ready.service.remove({
      tenantId: ready.tenantId,
      address: ready.address,
      alias: alias.data,
      actorId: ready.userId,
    })
    if (done.status === "not_found") {
      // The mailbox or the alias: the two read alike, so the route says which only
      // as far as the caller could already know (they named both).
      return c.json(NO_ALIAS, 404)
    }
    if (done.status === "not_removable")
      return c.json(
        conflict(
          "alias_not_removable",
          "That address comes from the person's account or a directory, and is removed there.",
        ),
        409,
      )
    return answer(c, done.aliases)
  })
}
