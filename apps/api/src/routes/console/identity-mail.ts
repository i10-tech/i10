import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import {
  LEAVER_MAX_DAYS,
  LEAVER_MIN_DAYS,
  chooseNext,
  runDue,
  setGroupMail,
  type DirectoryMailDeps,
  type MailboxRow,
} from "../../identity/directory-mail.js"
import { safeError } from "../../identity/directory.js"
import type { GroupMailStore } from "../../identity/mail-store.js"

/**
 * Mail from the directory (#344, sso.md 2.8), for the directory pages (#340).
 *
 *   PUT    /identity/directories/:id/groups/:groupId/mail   { address, kind } an admin opts a group in
 *   DELETE /identity/directories/:id/groups/:groupId/mail   opts it out
 *   GET    /identity/mailboxes                              suspended and directory-given mailboxes
 *   PUT    /identity/mailboxes/:userId/next                 { next, delegateUserId?, days? } what a suspended mailbox does next
 *   PUT    /identity/mail/leavers                           { action, days? } the workspace's default
 *
 * "Create mailboxes" itself is a setting of the directory
 * (`PATCH /identity/directories/:id`, identity-scim.ts), because turning it on
 * is an owner's move and every other trust setting of a directory lives there.
 *
 * ⚠ EVERY CHANGE NEEDS STEP-UP AND IS AUDITED WITH THE ACTOR. A list makes an
 * address that receives (and fans out) the workspace's mail; a suspended
 * mailbox's next step can forward, share or delete it.
 *
 * ⚠ AN ADMIN (`sso:manage`) PICKS A MAILBOX'S NEXT STEP; THE WORKSPACE-WIDE
 * DEFAULT OF DELETING IS AN OWNER'S. A default applies to every person a
 * directory ever switches off, without anyone looking at them one by one.
 */

export interface MailConsoleDeps {
  deps: DirectoryMailDeps
  groups: GroupMailStore
}

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const CLERK_ID = /^user_[A-Za-z0-9]{1,64}$/

const groupMail = z
  .object({
    address: z.string().trim().min(3).max(320),
    kind: z.enum(["list", "shared"]),
  })
  .strict()

const next = z.discriminatedUnion("next", [
  z.object({ next: z.literal("keep") }).strict(),
  z.object({ next: z.literal("forward_manager") }).strict(),
  z
    .object({
      next: z.literal("delegate"),
      delegateUserId: z.string().regex(CLERK_ID),
    })
    .strict(),
  z
    .object({
      next: z.literal("delete"),
      days: z.number().int().min(LEAVER_MIN_DAYS).max(LEAVER_MAX_DAYS),
    })
    .strict(),
])

const leavers = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("forward_manager") }).strict(),
  z
    .object({
      action: z.literal("delete_after"),
      days: z.number().int().min(LEAVER_MIN_DAYS).max(LEAVER_MAX_DAYS),
    })
    .strict(),
])

const rowView = (r: MailboxRow) => ({
  userId: r.clerkUserId,
  address: r.address,
  state: r.state,
  suspendedAt: r.suspendedAt,
  next: r.next,
  targetUserId: r.targetUserId,
  deleteAfterDays: r.deleteAfterDays,
  deleteAt: r.deleteAt,
})

const REFUSALS: Record<string, string> = {
  not_found: "No such group.",
  address_not_hosted:
    "The list address must be on a domain this workspace hosts mail for.",
  name_not_hosted:
    "This group's name is an address on a domain this workspace does not host mail for.",
  invalid_address: "Enter a valid list address.",
  taken: "That address is already a mailbox, an alias or another list.",
}

export function mountIdentityMail(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }
  const wired = () => d.identity?.mail ?? null

  app.put(
    "/identity/directories/:id/groups/:groupId/mail",
    requireFreshAuth,
    async (c) => {
      const mail = wired()
      if (!mail) return c.json(notWired("Directory mail"), 501)
      if (!(await allowed(c, "sso:manage")))
        return c.json(forbidden("Only an admin can make a group a mailing list."), 403)
      const parsed = groupMail.safeParse((await readJson(c)) ?? {})
      if (!parsed.success)
        return c.json(
          validation(parsed.error.issues[0]?.message ?? "Invalid list."),
          422,
        )
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const outcome = await setGroupMail(
        {
          store: { ...mail.groups, hostedBy: (x) => mail.deps.store.hostedBy(x) },
          record: mail.deps.record,
        },
        {
          tenantId,
          directoryId: c.req.param("id") ?? "",
          groupId: c.req.param("groupId") ?? "",
          actorUserId: userId,
          mail: parsed.data,
        },
      )
      if (outcome === "ok") return c.json({ ok: true })
      return c.json(
        outcome === "not_found"
          ? notFound(REFUSALS.not_found)
          : validation(REFUSALS[outcome] ?? "Refused."),
        outcome === "not_found" ? 404 : 422,
      )
    },
  )

  app.delete(
    "/identity/directories/:id/groups/:groupId/mail",
    requireFreshAuth,
    async (c) => {
      const mail = wired()
      if (!mail) return c.json(notWired("Directory mail"), 501)
      if (!(await allowed(c, "sso:manage")))
        return c.json(forbidden("Only an admin can change a mailing list."), 403)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const outcome = await setGroupMail(
        {
          store: { ...mail.groups, hostedBy: (x) => mail.deps.store.hostedBy(x) },
          record: mail.deps.record,
        },
        {
          tenantId,
          directoryId: c.req.param("id") ?? "",
          groupId: c.req.param("groupId") ?? "",
          actorUserId: userId,
          mail: null,
        },
      )
      return outcome === "ok"
        ? c.json({ ok: true })
        : c.json(notFound(REFUSALS.not_found), 404)
    },
  )

  app.get("/identity/mailboxes", async (c) => {
    const mail = wired()
    if (!mail) return c.json(notWired("Directory mail"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see directory mailboxes."), 403)
    const { tenantId } = c.get("auth")
    // The backup for a deletion job that was lost: whatever is due is deleted now.
    try {
      await runDue(mail.deps, tenantId)
    } catch (error) {
      d.identity?.log.warn(
        { ...safeError(error), tenantId },
        "could not run the due mailbox deletions",
      )
    }
    const [rows, policy] = await Promise.all([
      mail.deps.store.mailboxes(tenantId),
      mail.deps.store.leaverDefault(tenantId),
    ])
    return c.json({
      data: rows.map(rowView),
      leavers: policy,
      limits: { minDays: LEAVER_MIN_DAYS, maxDays: LEAVER_MAX_DAYS },
    })
  })

  app.put("/identity/mailboxes/:userId/next", requireFreshAuth, async (c) => {
    const mail = wired()
    if (!mail) return c.json(notWired("Directory mail"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(
        forbidden("Only an admin can decide what happens to a mailbox."),
        403,
      )
    const target = c.req.param("userId") ?? ""
    if (!CLERK_ID.test(target)) return c.json(notFound(), 404)
    const parsed = next.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid choice."),
        422,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const done = await chooseNext(mail.deps, {
      tenantId,
      clerkUserId: target,
      actorUserId: userId,
      choice: parsed.data,
    })
    switch (done.outcome) {
      case "ok":
        return c.json({ ok: true, next: done.next })
      case "not_suspended":
        return c.json(notFound("That mailbox is not suspended."), 404)
      case "bad_days":
        return c.json(
          validation(`Delete after ${LEAVER_MIN_DAYS} to ${LEAVER_MAX_DAYS} days.`),
          422,
        )
      case "still_active":
        return c.json(validation("A directory still says this person is active."), 422)
      case "refused":
        return c.json(
          validation(`Not possible: ${done.reason.replaceAll("_", " ")}.`),
          422,
        )
    }
  })

  app.put("/identity/mail/leavers", requireFreshAuth, async (c) => {
    const mail = wired()
    if (!mail) return c.json(notWired("Directory mail"), 501)
    const parsed = leavers.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid setting."),
        422,
      )
    // ⚠ DELETING EVERYONE A DIRECTORY SWITCHES OFF IS AN OWNER'S CALL.
    const needed: Permission =
      parsed.data.action === "delete_after" ? "owners:manage" : "sso:manage"
    if (!(await allowed(c, needed)))
      return c.json(
        forbidden(
          needed === "owners:manage"
            ? "Only an owner can delete the mailboxes of everyone a directory switches off."
            : "Only an admin can change this.",
        ),
        403,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const before = await mail.deps.store.leaverDefault(tenantId)
    const days = parsed.data.action === "delete_after" ? parsed.data.days : null
    await mail.deps.store.setLeaverDefault(
      tenantId,
      { action: parsed.data.action, days, by: userId },
      {
        type: "mailbox.leaver_default_set",
        actorUserId: userId,
        data: { from: before, to: { action: parsed.data.action, days } },
      },
    )
    return c.json({ action: parsed.data.action, days })
  })
}
