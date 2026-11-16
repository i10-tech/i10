import type { Context, Hono } from "hono"
import { adminCreateMailboxSchema, setMailboxCreationSchema } from "@repo/contracts"
import type { ProvisionOutcome } from "../../mailboxes/provision.js"
import { freshAuthRefusal } from "../../middleware/session.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * An owner or admin's side of mailboxes: giving a member one, and choosing who
 * creates them.
 *
 *   POST /mailboxes                 create a mailbox for an existing member (step-up)
 *   GET  /mailboxes/creation-mode   who creates mailboxes: admins, members or on_join
 *   PUT  /mailboxes/creation-mode   change it (step-up)
 *
 * ⚠ THE ORDER IS ROLE, THEN STEP-UP, THEN THE BODY, THEN THE TARGET. A member is
 * refused (403) before they are asked to re-authenticate for something they will
 * never be allowed, and nobody learns anything about the body or the target
 * before proving they may ask. The target comes last because it is named in the
 * body: a person who is not a member of THIS workspace is a 404, the same answer
 * as an id that does not exist, so the route cannot be used to probe other
 * workspaces' users.
 *
 * ⚠ MOUNTED BEFORE `mountMailboxes` in `routes/console.ts` so the static
 * `/mailboxes/creation-mode` matches before `/mailboxes/:address`.
 *
 * ⚠ THE CREATION ITSELF IS `MailboxProvisioning.create`, NOT A SECOND INSERT PATH.
 * This file turns a session into an actor and an outcome into a status; the
 * domain, address, seat and sign-in checks are the ones a person's own request
 * meets, and `create` re-asks whether the actor administers the workspace.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const NO_MEMBER = notFound("No such member in this workspace.")

const refusal = (statusCode: 403 | 409, name: string, message: string) =>
  ({ statusCode, name, message }) as const

/** The same names and statuses as a person's own `POST /mailboxes`. */
function answer(c: Context, outcome: ProvisionOutcome) {
  switch (outcome.status) {
    case "created":
      return c.json(outcome.mailbox, 201)
    case "password_required":
    case "mail_signin_off":
      return c.json(refusal(409, outcome.status, outcome.reason), 409)
    case "conflict":
      return c.json(refusal(409, "mailbox_already_exists", outcome.reason), 409)
    case "limit":
      return c.json(refusal(403, "plan_limit_exceeded", outcome.reason), 403)
    case "forbidden":
      return c.json(refusal(403, "invalid_access", outcome.reason), 403)
    default:
      return c.json(validation(outcome.reason), 422)
  }
}

export function mountMailboxAdmin(app: Hono, d: ConsoleDeps): void {
  const actorOf = (c: Context) => ({
    tenantId: c.get("auth").tenantId,
    userId: c.get("user").userId,
  })

  app.post("/mailboxes", async (c) => {
    const admin = d.mailboxAdmin
    if (!admin) return c.json(notWired("Mailbox creation"), 501)
    const { tenantId, userId } = actorOf(c)
    if (!(await admin.isAdmin(tenantId, userId))) {
      return c.json(
        forbidden("Only an owner or admin can create a mailbox for a member."),
        403,
      )
    }
    const stepUp = await freshAuthRefusal(c)
    if (stepUp) return stepUp

    const parsed = adminCreateMailboxSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid request."),
        422,
      )
    }
    const { user_id: targetId, ...input } = parsed.data
    if (!(await admin.isMember(tenantId, targetId))) return c.json(NO_MEMBER, 404)

    return answer(
      c,
      await admin.provisioning.create(targetId, input, { actorId: userId, tenantId }),
    )
  })

  app.get("/mailboxes/creation-mode", async (c) => {
    const admin = d.mailboxAdmin
    if (!admin) return c.json(notWired("Mailbox creation"), 501)
    const { tenantId, userId } = actorOf(c)
    if (!(await admin.isAdmin(tenantId, userId))) {
      return c.json(forbidden("Only an owner or admin can see this setting."), 403)
    }
    return c.json({ mode: await admin.settings.get(tenantId) })
  })

  app.put("/mailboxes/creation-mode", async (c) => {
    const admin = d.mailboxAdmin
    if (!admin) return c.json(notWired("Mailbox creation"), 501)
    const { tenantId, userId } = actorOf(c)
    if (!(await admin.isAdmin(tenantId, userId))) {
      return c.json(forbidden("Only an owner or admin can change this setting."), 403)
    }
    const stepUp = await freshAuthRefusal(c)
    if (stepUp) return stepUp

    const parsed = setMailboxCreationSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(validation("mode must be one of admins, members or on_join."), 422)
    }
    const done = await admin.settings.set(tenantId, userId, parsed.data.mode)
    return c.json({ mode: done.after })
  })
}
