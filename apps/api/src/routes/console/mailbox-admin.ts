import type { Context, Hono } from "hono"
import {
  adminCreateMailboxSchema,
  deleteMailboxSchema,
  mailboxAddressSchema,
  setMailboxCreationSchema,
} from "@repo/contracts"
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
 *   POST /mailboxes/:address/suspend   stop the login, keep the mail (step-up)
 *   POST /mailboxes/:address/resume    lift an owner's suspension (step-up)
 *   POST /mailboxes/:address/delete    delete with a 30 day way back (step-up)
 *   POST /mailboxes/:address/restore   undo a deletion inside the 30 days (step-up)
 *
 * ⚠ THE LIFECYCLE ROUTES ARE POSTS TO A VERB, NOT A DELETE ON THE MAILBOX: a
 * deletion carries a body (what to do with the address) and is undone by another
 * call, so it is not the one-way `DELETE` a client would expect that to be.
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

const NO_MAILBOX = notFound("No such mailbox in this workspace.")

const conflict = (name: string, message: string) =>
  ({ statusCode: 409, name, message }) as const

const RESUME_REFUSALS = {
  not_suspended: "That mailbox is not suspended.",
  deleting: "That mailbox is being deleted. Restore it instead.",
  not_member:
    "That person is not a member of this workspace. Add them first; a removed member's mailbox does not come back with a click.",
  directory_deactivated:
    "A directory still says this person is deactivated. Only the directory brings them back.",
  domain_not_hosted: "This workspace no longer hosts mail on that mailbox's domain.",
} as const

const DELETE_REFUSALS = {
  already: conflict("already_deleting", "That mailbox is already being deleted."),
  forward_invalid: validation(
    "forward_to must be another mailbox of this workspace that can sign in and receive mail.",
  ),
  forward_exists: conflict(
    "forward_exists",
    "Mail for that address is already forwarded somewhere else.",
  ),
  forward_target_in_use: conflict(
    "forward_target_in_use",
    "Other addresses are forwarded to this mailbox. Move them first.",
  ),
  export_unavailable: {
    statusCode: 501,
    name: "internal_server_error",
    message: "Mailbox export is not configured on this deployment.",
  },
  export_failed: {
    statusCode: 503,
    name: "application_error",
    message: "The export could not be started, so nothing was deleted. Try again.",
  },
} as const

export function mountMailboxAdmin(app: Hono, d: ConsoleDeps): void {
  const actorOf = (c: Context) => ({
    tenantId: c.get("auth").tenantId,
    userId: c.get("user").userId,
  })

  /**
   * The mailbox after a change, as the list shows it, or `ok` where nothing reads it.
   *
   * ⚠ READ AS AN ADMIN BECAUSE THE CALLER IS ONE: every lifecycle route has passed
   * the role check before it answers.
   */
  const after = async (c: Context, address: string) => {
    const { tenantId, userId } = actorOf(c)
    const mailbox = await d.mailboxes?.get({ tenantId, userId, isAdmin: true }, address)
    return c.json(mailbox ? { mailbox } : { ok: true })
  }

  /**
   * The four lifecycle routes share their opening: wired, then role, then step-up,
   * then the address in the path (404 when it is none of this workspace's).
   */
  const lifecycle = async (c: Context) => {
    const life = d.mailboxLifecycle
    if (!life) return { refused: c.json(notWired("Mailbox lifecycle"), 501) } as const
    const { tenantId, userId } = actorOf(c)
    if (!(await life.isAdmin(tenantId, userId))) {
      return {
        refused: c.json(
          forbidden("Only an owner or admin can change or delete a mailbox."),
          403,
        ),
      } as const
    }
    const stepUp = await freshAuthRefusal(c)
    if (stepUp) return { refused: stepUp } as const
    let decoded: string
    try {
      decoded = decodeURIComponent(c.req.param("address") ?? "")
    } catch {
      return { refused: c.json(NO_MAILBOX, 404) } as const
    }
    const parsed = mailboxAddressSchema.safeParse(decoded)
    if (!parsed.success) return { refused: c.json(NO_MAILBOX, 404) } as const
    return { life, tenantId, userId, address: parsed.data } as const
  }

  app.post("/mailboxes/:address/suspend", async (c) => {
    const ready = await lifecycle(c)
    if ("refused" in ready) return ready.refused
    const done = await ready.life.suspend({
      tenantId: ready.tenantId,
      address: ready.address,
      actorId: ready.userId,
    })
    if (done === "not_found") return c.json(NO_MAILBOX, 404)
    if (done === "deleting")
      return c.json(
        conflict("mailbox_deleting", "That mailbox is being deleted already."),
        409,
      )
    return after(c, ready.address)
  })

  app.post("/mailboxes/:address/resume", async (c) => {
    const ready = await lifecycle(c)
    if ("refused" in ready) return ready.refused
    const done = await ready.life.resume({
      tenantId: ready.tenantId,
      address: ready.address,
      actorId: ready.userId,
    })
    if (done.status === "not_found") return c.json(NO_MAILBOX, 404)
    if (done.status !== "resumed")
      return c.json(conflict(done.status, RESUME_REFUSALS[done.status]), 409)
    // ⚠ WHAT STILL REFUSES THE LOGIN IS SAID, NOT HIDDEN: a payment hold, a ban or a
    // lock is not an owner's to lift, and "resumed" with no warning would read as a
    // login that works.
    const mailbox = await d.mailboxes?.get(
      { tenantId: ready.tenantId, userId: ready.userId, isAdmin: true },
      ready.address,
    )
    return c.json({
      ok: true,
      still_blocked: done.stillBlocked,
      mailbox: mailbox ?? null,
    })
  })

  app.post("/mailboxes/:address/delete", async (c) => {
    const ready = await lifecycle(c)
    if ("refused" in ready) return ready.refused
    const parsed = deleteMailboxSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid request."),
        422,
      )
    }
    const done = await ready.life.remove({
      tenantId: ready.tenantId,
      address: ready.address,
      actorId: ready.userId,
      request: parsed.data,
    })
    if (done.status === "not_found") return c.json(NO_MAILBOX, 404)
    if (done.status !== "deleting") {
      const refusal = DELETE_REFUSALS[done.status]
      return c.json(refusal, refusal.statusCode)
    }
    return after(c, ready.address)
  })

  app.post("/mailboxes/:address/restore", async (c) => {
    const ready = await lifecycle(c)
    if ("refused" in ready) return ready.refused
    const done = await ready.life.restore({
      tenantId: ready.tenantId,
      address: ready.address,
      actorId: ready.userId,
    })
    if (done === "not_found") return c.json(NO_MAILBOX, 404)
    if (done === "not_deleting")
      return c.json(conflict("not_deleting", "That mailbox is not being deleted."), 409)
    if (done === "window_closed")
      return c.json(
        conflict(
          "restore_window_closed",
          "The 30 days to restore this mailbox are over, and it is being removed.",
        ),
        409,
      )
    return after(c, ready.address)
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
