import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import { wasDeprovisioned } from "../../console/api-key-access.js"
import { revokeKey, rotateKey } from "../../auth/key-actions.js"

/**
 * What to do about the API keys of somebody who was deprovisioned (#345).
 *
 *   GET  /identity/deprovisioned/api-keys                           every live key of anybody deprovisioned
 *   GET  /identity/deprovisioned/:userId/api-keys                   the live keys they created
 *   POST /identity/deprovisioned/:userId/api-keys/:keyId/rotate     (owner, step-up)
 *   POST /identity/deprovisioned/:userId/api-keys/:keyId/revoke     (owner, step-up)
 *
 * ⚠ NOTHING IS REVOKED AUTOMATICALLY, EVER. A key belongs to the workspace; the
 * creator is audit only (core `api_keys.created_by`), and an integration must
 * not stop because an employee left. These routes only show the admin what
 * the person created and let an owner act, one key at a time.
 *
 * ⚠ ONLY FOR SOMEBODY WHO WAS DEPROVISIONED. The routes are not a way to list
 * or rotate anybody's keys: the person must have a `member.deprovisioned`
 * event in this workspace's audit log, and a key must be one they created.
 *
 * ⚠ ROTATING AND REVOKING GO THROUGH THE CONSOLE'S OWN KEY PATH (`revokeKey`,
 * `rotateKey` in auth/key-actions.ts), so the cache eviction that makes
 * revocation immediate is the same one. Listing is an SSO admin's
 * (`sso:manage`); acting is an owner's (`owners:manage`) - a stricter rule than
 * the key routes themselves, because this is one person's leftovers being
 * swept up by somebody who may not own the integration.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER = /^[A-Za-z0-9_]{1,64}$/

export function mountIdentityApiKeys(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  const present = (k: {
    id: string
    name: string
    prefix: string
    mode: string
    createdAt: Date
    lastUsedAt: Date | null
    expiresAt: Date | null
  }) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    mode: k.mode,
    created_at: k.createdAt.toISOString(),
    last_used_at: k.lastUsedAt?.toISOString() ?? null,
    expires_at: k.expiresAt?.toISOString() ?? null,
  })

  // ⚠ ONE QUERY IN THE STORE, NOT A PAGE OF EVENTS: a leaver from long ago whose
  // key still works must be on this list. Same definition of "deprovisioned" as
  // `wasDeprovisioned`, so this list and the per-person routes cannot disagree.
  app.get("/identity/deprovisioned/api-keys", async (c) => {
    if (!d.identity || !d.keys) return c.json(notWired("API keys"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see this."), 403)
    const { tenantId } = c.get("auth")
    const rows = await d.keys.store.createdByDeprovisioned(tenantId)
    const people = new Map<
      string,
      { user_id: string; deprovisioned_at: string; keys: ReturnType<typeof present>[] }
    >()
    for (const { key, deprovisionedAt } of rows) {
      if (!key.createdBy) continue
      const person = people.get(key.createdBy) ?? {
        user_id: key.createdBy,
        deprovisioned_at: deprovisionedAt.toISOString(),
        keys: [],
      }
      person.keys.push(present(key))
      people.set(key.createdBy, person)
    }
    return c.json({
      data: [...people.values()].sort((a, b) =>
        a.deprovisioned_at < b.deprovisioned_at ? 1 : -1,
      ),
    })
  })

  app.get("/identity/deprovisioned/:userId/api-keys", async (c) => {
    if (!d.identity || !d.keys) return c.json(notWired("API keys"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see this."), 403)
    const { tenantId } = c.get("auth")
    const member = c.req.param("userId")
    if (!USER.test(member) || !(await wasDeprovisioned(d, tenantId, member)))
      return c.json(notFound(), 404)
    const keys = await d.keys.store.createdBy(tenantId, member)
    return c.json({ data: keys.map(present) })
  })

  const act = (action: "rotate" | "revoke") =>
    app.post(
      `/identity/deprovisioned/:userId/api-keys/:keyId/${action}`,
      requireFreshAuth,
      async (c) => {
        if (!d.identity || !d.keys) return c.json(notWired("API keys"), 501)
        if (!(await allowed(c, "owners:manage")))
          return c.json(
            forbidden("Only an owner can rotate or revoke these keys."),
            403,
          )
        const { tenantId } = c.get("auth")
        const { userId: actor } = c.get("user")
        const member = c.req.param("userId")
        const keyId = c.req.param("keyId")
        if (!USER.test(member) || !UUID.test(keyId)) return c.json(notFound(), 404)
        if (!(await wasDeprovisioned(d, tenantId, member)))
          return c.json(notFound(), 404)
        // ⚠ THE KEY MUST BE ONE THEY CREATED AND THAT IS STILL LIVE: the route
        // is not a way to reach any other key of the workspace.
        const key = (await d.keys.store.createdBy(tenantId, member)).find(
          (k) => k.id === keyId,
        )
        if (!key) return c.json(notFound("No such key."), 404)

        if (action === "revoke") {
          const done = await revokeKey(d.keys, tenantId, keyId, d.log)
          if (done.status === "not_found") return c.json(notFound("No such key."), 404)
          await d.identity.store.record(tenantId, {
            type: "member.api_key_revoked",
            actorUserId: actor,
            subjectUserId: member,
            data: { keyId, name: key.name },
          })
          if (done.status === "cache_failed")
            return c.json(
              {
                statusCode: 500,
                name: "internal_server_error" as const,
                message:
                  "The key was revoked but may stay usable for up to a minute. Retry to confirm.",
              },
              500,
            )
          return c.json({ id: keyId, revoked: true })
        }

        // ⚠ THE NEW KEY IS THE ADMIN'S: attributed to whoever holds its secret.
        const done = await rotateKey(d.keys, tenantId, keyId, d.log, {
          createdBy: actor,
        })
        if (done.status === "not_found") return c.json(notFound("No such key."), 404)
        await d.identity.store.record(tenantId, {
          type: "member.api_key_rotated",
          actorUserId: actor,
          subjectUserId: member,
          data: { keyId, name: key.name, newKeyId: done.created.id },
        })
        return c.json(
          {
            id: done.created.id,
            name: done.created.name,
            prefix: done.created.prefix,
            mode: done.created.mode,
            created_at: done.created.createdAt.toISOString(),
            /** ⚠ THE ONLY TIME THIS IS SHOWN, as for any rotation. */
            secret: done.created.secret,
          },
          201,
        )
      },
    )
  act("rotate")
  act("revoke")
}
