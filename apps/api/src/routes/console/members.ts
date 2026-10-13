import type { Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { asId, notFound, notWired, readJson, validation } from "./http.js"
import { MANAGE_MEMBERS } from "../../console/team-domains.js"
import {
  revokeExpired,
  sendInvitations,
  seats,
  withdrawInvitation,
} from "../../console/members.js"
import { zoneCatalog } from "../../console/zones.js"

/**
 * Member limits, invitations with a chosen expiry, and capacity (#327).
 *
 * ⚠ EVERY WRITE ASKS CLERK FOR THE MEMBERS-MANAGE PERMISSION, like the team
 * routes beside it; the console hiding a button is not the check.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const noTeam = validation("Invitations need a team workspace.")

export function mountMembers(app: Hono, d: ConsoleDeps): void {
  const isAdmin = async (userId: string, orgId: string | undefined) =>
    Boolean(
      orgId &&
      d.teamDomains &&
      (await d.teamDomains.can(userId, orgId, MANAGE_MEMBERS)),
    )

  /**
   * How full the workspace is: members, invitations, the limit, and - for the
   * invitation form's last-spot warning - the access patterns that let people
   * in. The capacity alert's state for admins, for the banner.
   */
  app.get("/team/capacity", async (c) => {
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    if (!d.members || !orgId) return c.json({ data: null })
    await revokeExpired(d.members, tenantId)
    const [room, admin, access] = await Promise.all([
      seats(d.members, tenantId, orgId),
      isAdmin(userId, orgId),
      d.teamDomains ? d.teamDomains.store.accessDomains(tenantId) : Promise.resolve([]),
    ])
    const alert = admin ? await d.members.store.alert(tenantId) : null
    return c.json({
      data: {
        members: room.members,
        invitations: room.invitations,
        limit: room.limit,
        free: room.free,
        full: room.full,
        reasons: room.reasons,
        can_upgrade: room.canUpgrade,
        personal: room.personal,
        patterns: access
          .filter((a) => a.status === "verified")
          .flatMap((a) =>
            a.rules.filter((r) => r.mode !== "off").map((r) => r.pattern),
          ),
        alert: alert
          ? {
              level: alert.level,
              alerted_at: alert.alertedAt?.toISOString() ?? null,
            }
          : null,
      },
    })
  })

  /** Pending invitations we sent, soonest to expire first. */
  app.get("/team/invitations", async (c) => {
    const { tenantId } = c.get("auth")
    if (!d.members) return c.json({ data: [] })
    await revokeExpired(d.members, tenantId)
    const rows = await d.members.store.pendingInvitations(tenantId)
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expires_at: r.expiresAt.toISOString(),
        zone: r.zone,
        country: r.country,
        created_at: r.createdAt.toISOString(),
      })),
    })
  })

  app.post("/team/invitations", async (c) => {
    if (!d.members) return c.json(notWired("Invitations"), 501)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    if (!orgId) return c.json(noTeam, 422)
    if (!(await isAdmin(userId, orgId)))
      return c.json(forbidden("Only an admin can invite people."), 403)
    const body = await readJson(c)
    const sent = await sendInvitations(d.members, {
      tenantId,
      orgId,
      userId,
      emails: body?.emails,
      role: body?.role,
      expiresAt: body?.expires_at,
      zone: body?.zone,
      country: body?.country,
    })
    switch (sent.outcome) {
      case "ok":
        return c.json({ sent: sent.sent, failed: sent.failed }, 201)
      case "personal":
        return c.json(
          validation(
            "A Personal workspace is just for you. Turn it into a team first.",
          ),
          422,
        )
      case "invalid":
        return c.json(validation(sent.error), 422)
      default:
        return c.json(
          {
            statusCode: 409,
            name: "workspace_full",
            message:
              sent.free === 0
                ? "This workspace is full."
                : `Only ${sent.free} ${sent.free === 1 ? "spot is" : "spots are"} free.`,
            free: sent.free,
            reasons: sent.reasons,
          },
          409,
        )
    }
  })

  app.delete("/team/invitations/:id", async (c) => {
    if (!d.members) return c.json(notWired("Invitations"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(notFound("No such invitation."), 404)
    const { tenantId } = c.get("auth")
    const { userId, orgId } = c.get("user")
    if (!(await isAdmin(userId, orgId)))
      return c.json(forbidden("Only an admin can withdraw invitations."), 403)
    const outcome = await withdrawInvitation(d.members, { tenantId, id })
    if (outcome === "ok") return c.body(null, 204)
    return c.json(notFound("That invitation was already accepted or ended."), 404)
  })

  /**
   * Countries and time zones for the expiry picker, from the runtime's own
   * `Intl` (see console/zones.ts). Static for the life of the process.
   */
  app.get("/team/time-zones", (c) => c.json(zoneCatalog()))
}
