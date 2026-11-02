import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import { subjectFingerprint } from "../../identity/model.js"

/**
 * A changed IdP subject waiting for an owner (sso.md 2.22): somebody's company
 * login was renamed or recreated, their sign-in was refused `subject_changed`,
 * and the connection's `relink` setting left the move to us.
 *
 *   GET  /identity/connections/:id/relinks                       pending requests, oldest first
 *   POST /identity/connections/:id/relinks/:requestId/approve    move the link (owner, step-up)
 *   POST /identity/connections/:id/relinks/:requestId/reject     delete the request (owner, step-up)
 *
 * ⚠ APPROVING IS AN OWNER'S, ALWAYS: it decides which IdP login is that
 * person, which is the trust the connection exists to hold. Admins can see the
 * list and ask an owner. Approval moves nothing the next sign-in does not
 * check again: the account is still managed, still on a proved domain.
 *
 * ⚠ BOTH ARE AUDITED WITH THE ACTOR, and neither audit row carries a subject
 * or an address: subjects are fingerprints (a username or primary email would
 * be in the clear otherwise).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const conflict = (message: string) =>
  ({ statusCode: 409, name: "conflict" as const, message }) as const

export function mountIdentityRelinks(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  app.get("/identity/connections/:id/relinks", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const connectionId = c.req.param("id")
    if (!UUID.test(connectionId)) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    if (!(await id.store.connection(tenantId, connectionId)))
      return c.json(notFound(), 404)
    const rows = await id.store.relinkRequests(tenantId, connectionId, new Date())
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        identityId: r.identityId,
        clerkUserId: r.clerkUserId,
        email: r.email,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
    })
  })

  app.post(
    "/identity/connections/:id/relinks/:requestId/approve",
    requireFreshAuth,
    async (c) => {
      const id = d.identity
      if (!id) return c.json(notWired("SSO connections"), 501)
      if (!(await allowed(c, "owners:manage")))
        return c.json(forbidden("Only an owner can approve a relink."), 403)
      const connectionId = c.req.param("id")
      const requestId = c.req.param("requestId")
      if (!UUID.test(connectionId) || !UUID.test(requestId))
        return c.json(notFound(), 404)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      if (!(await id.store.connection(tenantId, connectionId)))
        return c.json(notFound(), 404)
      const done = await id.store.approveRelink(tenantId, {
        connectionId,
        requestId,
        now: new Date(),
      })
      if (done.outcome === "not_found") return c.json(notFound(), 404)
      // ⚠ THE NEW SUBJECT IS ALREADY SOMEBODY ELSE'S ON THIS CONNECTION: moving
      // it would sign two people in as one, so nothing moves.
      if (done.outcome === "conflict")
        return c.json(
          conflict("That login is already linked to another person on this connection."),
          409,
        )
      if (done.outcome === "gone")
        return c.json(conflict("That person's link changed. Refresh and check again."), 409)
      await id.store.record(tenantId, {
        type: "identity.relinked",
        actorUserId: userId,
        subjectUserId: done.clerkUserId,
        connectionId,
        reason: "approved",
        data: {
          identityId: done.identityId,
          connectionId,
          from: subjectFingerprint(done.from),
          to: subjectFingerprint(done.to),
          via: "approval",
          approvedBy: userId,
        },
      })
      return c.json({ ok: true })
    },
  )

  app.post(
    "/identity/connections/:id/relinks/:requestId/reject",
    requireFreshAuth,
    async (c) => {
      const id = d.identity
      if (!id) return c.json(notWired("SSO connections"), 501)
      if (!(await allowed(c, "owners:manage")))
        return c.json(forbidden("Only an owner can reject a relink."), 403)
      const connectionId = c.req.param("id")
      const requestId = c.req.param("requestId")
      if (!UUID.test(connectionId) || !UUID.test(requestId))
        return c.json(notFound(), 404)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const gone = await id.store.rejectRelink(tenantId, connectionId, requestId)
      if (!gone) return c.json(notFound(), 404)
      await id.store.record(tenantId, {
        type: "identity.relink_rejected",
        actorUserId: userId,
        connectionId,
        data: { identityId: gone.identityId, connectionId, rejectedBy: userId },
      })
      return c.json({ ok: true })
    },
  )
}
