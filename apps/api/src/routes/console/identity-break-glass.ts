import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import { OWNER_GUARDED } from "../../identity/model.js"

/**
 * Break-glass (#340, sso.md 2.10 and decision 7): the bypass list of each
 * connection, and the workspace's owner exemption.
 *
 *   GET    /identity/connections/:id/bypass               who may skip this connection
 *   POST   /identity/connections/:id/bypass               { userId, reason } (step-up)
 *   DELETE /identity/connections/:id/bypass/:userId       (step-up)
 *   GET    /identity/owner-exemption                      on or off, and a pending request
 *   POST   /identity/owner-exemption/off-request          a first owner asks to turn it off (step-up)
 *   POST   /identity/owner-exemption/off-request/approve  a second owner applies it (step-up)
 *   DELETE /identity/owner-exemption/off-request          any owner withdraws the request
 *   POST   /identity/owner-exemption/on                   one owner turns it back on (step-up)
 *
 * ⚠ THE BYPASS LIST IS TRUST. Whoever is on it signs in without the IdP, so
 * on an `active` or `disabled` connection only an owner changes it, as with
 * the connection's issuer and domains; on draft and testing `sso:manage` is
 * enough. Every change is audited with the actor and its reason.
 *
 * ⚠ TURNING THE EXEMPTION OFF TAKES TWO DIFFERENT OWNERS within a day
 * (decision 7): with it off, unmanaged owners and admins are covered by
 * "required" like everybody else, and since SSO never signs them in
 * (`role_exempt`), only the bypass list keeps them in. One owner must never
 * be able to do that to the others alone.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_ID = /^user_[A-Za-z0-9]{1,64}$/

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const
const conflict = (message: string) =>
  ({ statusCode: 409, name: "conflict" as const, message }) as const

const BypassInput = z
  .object({
    userId: z.string().regex(USER_ID),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()

export function mountIdentityBreakGlass(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  /** The connection a bypass route names, after the permission checks. */
  const loadForBypass = async (c: Context, write: boolean) => {
    const id = d.identity
    if (!id?.policy) return { error: c.json(notWired("SSO bypass lists"), 501) }
    if (!(await allowed(c, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can manage SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { error: c.json(notFound(), 404) }
    if (
      write &&
      OWNER_GUARDED.includes(connection.status) &&
      !(await allowed(c, "owners:manage"))
    )
      return {
        error: c.json(
          forbidden("Only an owner can change who may skip an active connection."),
          403,
        ),
      }
    return { id, policy: id.policy, connection, tenantId }
  }

  app.get("/identity/connections/:id/bypass", async (c) => {
    const loaded = await loadForBypass(c, false)
    if ("error" in loaded) return loaded.error
    const rows = await loaded.policy.bypassList(loaded.tenantId, loaded.connection.id)
    return c.json({
      data: rows.map((r) => ({
        userId: r.clerkUserId,
        reason: r.reason,
        addedBy: r.addedBy,
        createdAt: r.createdAt,
      })),
    })
  })

  app.post("/identity/connections/:id/bypass", requireFreshAuth, async (c) => {
    const loaded = await loadForBypass(c, true)
    if ("error" in loaded) return loaded.error
    const { id, policy, connection, tenantId } = loaded
    const parsed = BypassInput.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation("Give a member's user id and a reason (1 to 500 characters)."),
        422,
      )
    const { userId: member, reason } = parsed.data
    // ⚠ A MEMBER OF THIS WORKSPACE ONLY: our roles table holds every member.
    if (!d.roles || (await d.roles.store.roleOf(tenantId, member)) === null)
      return c.json(notFound("That person is not a member of this workspace."), 404)
    const { userId } = c.get("user")
    const added = await policy.addBypass(tenantId, connection.id, {
      clerkUserId: member,
      reason,
      addedBy: userId,
    })
    if (added === "not_found") return c.json(notFound(), 404)
    if (added === "exists")
      return c.json(conflict("That person is already on the list."), 409)
    id.enforcement?.forgetTenant(tenantId)
    await id.store.record(tenantId, {
      type: "bypass.added",
      actorUserId: userId,
      subjectUserId: member,
      connectionId: connection.id,
      data: { reason, status: connection.status },
    })
    return c.json({ userId: member, reason }, 201)
  })

  app.delete(
    "/identity/connections/:id/bypass/:userId",
    requireFreshAuth,
    async (c) => {
      const loaded = await loadForBypass(c, true)
      if ("error" in loaded) return loaded.error
      const { id, policy, connection, tenantId } = loaded
      const member = c.req.param("userId")
      if (!USER_ID.test(member)) return c.json(notFound(), 404)
      const gone = await policy.removeBypass(tenantId, connection.id, member)
      if (!gone) return c.json(notFound(), 404)
      id.enforcement?.forgetTenant(tenantId)
      await id.store.record(tenantId, {
        type: "bypass.removed",
        actorUserId: c.get("user").userId,
        subjectUserId: member,
        connectionId: connection.id,
        data: { status: connection.status },
      })
      return c.json({ ok: true })
    },
  )

  // ── The owner exemption ────────────────────────────────────────────────

  /** The exemption routes' dependencies, after the permission check. */
  const loadForExemption = async (c: Context, permission: Permission) => {
    const id = d.identity
    if (!id?.policy) return { error: c.json(notWired("The owner exemption"), 501) }
    if (!(await allowed(c, permission)))
      return {
        error: c.json(
          forbidden(
            permission === "owners:manage"
              ? "Only an owner can change the owner exemption."
              : "Only an admin can see SSO settings.",
          ),
          403,
        ),
      }
    return { id, policy: id.policy, tenantId: c.get("auth").tenantId }
  }

  app.get("/identity/owner-exemption", async (c) => {
    const loaded = await loadForExemption(c, "sso:manage")
    if ("error" in loaded) return loaded.error
    return c.json(await loaded.policy.ownerExemption(loaded.tenantId, new Date()))
  })

  app.post("/identity/owner-exemption/off-request", requireFreshAuth, async (c) => {
    const loaded = await loadForExemption(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const { id, policy, tenantId } = loaded
    const { userId } = c.get("user")
    const now = new Date()
    const done = await policy.requestExemptionOff(tenantId, userId, now)
    if (done === "off")
      return c.json(conflict("The owner exemption is already off."), 409)
    if (done === "pending")
      return c.json(
        conflict("A request to turn it off is already waiting for another owner."),
        409,
      )
    await id.store.record(tenantId, {
      type: "owner_exemption.off_requested",
      actorUserId: userId,
    })
    return c.json(await policy.ownerExemption(tenantId, now), 202)
  })

  app.post(
    "/identity/owner-exemption/off-request/approve",
    requireFreshAuth,
    async (c) => {
      const loaded = await loadForExemption(c, "owners:manage")
      if ("error" in loaded) return loaded.error
      const { id, policy, tenantId } = loaded
      const { userId } = c.get("user")
      const now = new Date()
      const done = await policy.approveExemptionOff(tenantId, userId, now)
      if (done.outcome === "same_owner")
        return c.json(
          forbidden("A different owner has to approve turning the exemption off."),
          403,
        )
      if (done.outcome === "none")
        return c.json(
          conflict("There is no request from another owner to approve."),
          409,
        )
      id.enforcement?.forgetTenant(tenantId)
      await id.store.record(tenantId, {
        type: "owner_exemption.disabled",
        actorUserId: userId,
        data: { requestedBy: done.requestedBy },
      })
      return c.json(await policy.ownerExemption(tenantId, now))
    },
  )

  app.delete("/identity/owner-exemption/off-request", async (c) => {
    const loaded = await loadForExemption(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const { id, policy, tenantId } = loaded
    if (!(await policy.cancelExemptionOff(tenantId)))
      return c.json(notFound("There is no request to withdraw."), 404)
    await id.store.record(tenantId, {
      type: "owner_exemption.off_withdrawn",
      actorUserId: c.get("user").userId,
    })
    return c.json(await policy.ownerExemption(tenantId, new Date()))
  })

  app.post("/identity/owner-exemption/on", requireFreshAuth, async (c) => {
    const loaded = await loadForExemption(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const { id, policy, tenantId } = loaded
    const { userId } = c.get("user")
    if (await policy.enableExemption(tenantId, userId)) {
      id.enforcement?.forgetTenant(tenantId)
      await id.store.record(tenantId, {
        type: "owner_exemption.enabled",
        actorUserId: userId,
      })
    }
    return c.json(await policy.ownerExemption(tenantId, new Date()))
  })
}
