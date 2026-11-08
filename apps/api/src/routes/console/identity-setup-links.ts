import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can } from "../../console/roles.js"
import {
  SETUP_LINK_DEFAULT_HOURS,
  SETUP_LINK_MAX_HOURS,
  SETUP_STATUSES,
  hashSecret,
  newSetupToken,
  normaliseEmail,
} from "../../identity/model.js"
import type { SetupLinkRow } from "../../identity/ports.js"

/**
 * Setup links for a customer's IT contact (#340, sso.md 2.10): one link, one
 * connection in `draft` or `testing`, used at `/sso/setup/<token>/...`
 * (routes/sso-setup.ts).
 *
 *   GET  /identity/connections/:id/setup-links                  the links, never a token
 *   POST /identity/connections/:id/setup-links                  { expiresInHours?, contactEmail? } (step-up)
 *   POST /identity/connections/:id/setup-links/:linkId/revoke   { reason }
 *
 * ⚠ THE TOKEN IS SHOWN ONCE, in the answer to the POST; only its SHA-256 is
 * stored, and no route or audit row ever holds it again.
 *
 * ⚠ AN ADMIN'S TO MAKE (`sso:manage`, step-up): a link can do on a setup
 * connection exactly what an admin can there, and nothing an admin could not.
 * Revoking stays plain `sso:manage`, because it only takes access away.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const CreateInput = z
  .object({
    expiresInHours: z.number().int().min(1).max(SETUP_LINK_MAX_HOURS).optional(),
    contactEmail: z.string().max(320).nullable().optional(),
  })
  .strict()

const RevokeInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict()

/** What the console shows of a link. Never the token or its hash. */
export function setupLinkView(link: SetupLinkRow, now: Date) {
  return {
    id: link.id,
    connectionId: link.connectionId,
    contactEmail: link.contactEmail,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    usedAt: link.usedAt,
    revokedAt: link.revokedAt,
    revokedReason: link.revokedReason,
    live: !link.revokedAt && link.expiresAt.getTime() > now.getTime(),
  }
}

export function mountIdentitySetupLinks(app: Hono, d: ConsoleDeps): void {
  const load = async (c: Context) => {
    const id = d.identity
    if (!id?.policy) return { error: c.json(notWired("Setup links"), 501) }
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    if (!d.roles || !(await can(d.roles.store, tenantId, userId, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can manage SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { error: c.json(notFound(), 404) }
    return { id, policy: id.policy, connection, tenantId, userId }
  }

  app.get("/identity/connections/:id/setup-links", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const now = new Date()
    const rows = await loaded.policy.setupLinks(loaded.tenantId, loaded.connection.id)
    return c.json({ data: rows.map((r) => setupLinkView(r, now)) })
  })

  app.post("/identity/connections/:id/setup-links", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, policy, connection, tenantId, userId } = loaded
    /*
     * ⚠ ONLY WHILE NOBODY SIGNS IN THROUGH IT. An active or disabled
     * connection's trust is an owner's (OWNER_GUARDED); a link for one would
     * hand that to whoever holds the link.
     */
    if (!SETUP_STATUSES.includes(connection.status))
      return c.json(
        validation("Setup links are for connections still in draft or testing."),
        422,
      )
    const parsed = CreateInput.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(
          `expiresInHours must be 1 to ${SETUP_LINK_MAX_HOURS}, and contactEmail an address.`,
        ),
        422,
      )
    let contactEmail: string | null = null
    if (parsed.data.contactEmail) {
      contactEmail = normaliseEmail(parsed.data.contactEmail)
      if (!contactEmail)
        return c.json(validation("contactEmail must be an address."), 422)
    }
    const now = new Date()
    const hours = parsed.data.expiresInHours ?? SETUP_LINK_DEFAULT_HOURS
    const token = newSetupToken()
    const link = await policy.createSetupLink(tenantId, {
      connectionId: connection.id,
      tokenHash: hashSecret(token),
      contactEmail,
      createdBy: userId,
      expiresAt: new Date(now.getTime() + hours * 3600_000),
    })
    // ⚠ THE LINK'S ID, NEVER ITS TOKEN.
    await id.store.record(tenantId, {
      type: "setup_link.created",
      actorUserId: userId,
      connectionId: connection.id,
      data: {
        setupLinkId: link.id,
        expiresAt: link.expiresAt,
        contactEmail,
        status: connection.status,
      },
    })
    return c.json({ ...setupLinkView(link, now), token }, 201)
  })

  app.post("/identity/connections/:id/setup-links/:linkId/revoke", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, policy, connection, tenantId, userId } = loaded
    const linkId = c.req.param("linkId")
    if (!UUID.test(linkId)) return c.json(notFound(), 404)
    const parsed = RevokeInput.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(validation("Give a reason, 1 to 500 characters."), 422)
    const now = new Date()
    const revoked = await policy.revokeSetupLink(
      tenantId,
      connection.id,
      linkId,
      parsed.data.reason,
      now,
    )
    if (!revoked)
      return c.json(notFound("No such link, or it is already revoked."), 404)
    await id.store.record(tenantId, {
      type: "setup_link.revoked",
      actorUserId: userId,
      connectionId: connection.id,
      reason: "admin",
      data: { setupLinkId: linkId, note: parsed.data.reason },
    })
    return c.json(setupLinkView(revoked, now))
  })
}
