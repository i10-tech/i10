import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, mayRemove, type Permission } from "../../console/roles.js"
import { deprovision, type DeprovisionDeps } from "../../identity/managed.js"
import {
  ENFORCEMENTS,
  PROTOCOLS,
  STATUSES,
  type Connection,
  type Enforcement,
  type Protocol,
  type ConnectionStatus,
} from "../../identity/model.js"
import type {
  ConnectionPatch,
  ClerkIdentity,
  IdentityStore,
  Logger,
} from "../../identity/ports.js"
import type { SsoGateChecker } from "../../identity/gate.js"

/**
 * The identity core's console API (#337). The screens are #340's; these are
 * the routes they will call, and what the end-to-end run uses today.
 *
 *   GET    /identity/connections                         list, with domains
 *   POST   /identity/connections                         create a draft
 *   PATCH  /identity/connections/:id                     status, policy, mapping
 *   POST   /identity/connections/:id/domains             cover an access domain
 *   DELETE /identity/connections/:id/domains/:domainId   stop covering it
 *   GET    /identity/settings, PUT /identity/settings     deprovisioning mode
 *   GET    /identity/events                              the audit log
 *   GET    /identity/members/:userId/sessions            a member's bound sessions
 *   POST   /identity/members/:userId/sessions/:sid/revoke
 *   POST   /identity/members/:userId/deprovision         (step-up)
 *
 * ⚠ EVERY ROUTE CHECKS OUR ROLES TABLE (#335): `sso:manage` for setup,
 * `owners:manage` for what deprovisioning does, and the removal rule
 * (`mayRemove`) for another person's sessions. Every change that decides who
 * gets in needs step-up, and every setup change is an audit event with the
 * actor.
 */

export interface IdentityConsoleDeps {
  store: IdentityStore
  clerk: ClerkIdentity
  gate: SsoGateChecker
  /** The protocols an engine exists for in this process; `test` only in development. */
  protocols: readonly Protocol[]
  deprovision: DeprovisionDeps
  log: Logger
}

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const SESSION_ID = /^sess_[A-Za-z0-9]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function view(connection: Connection) {
  return {
    id: connection.id,
    name: connection.name,
    protocol: connection.protocol,
    provider: connection.provider,
    status: connection.status,
    enforcement: connection.enforcement,
    jitEnabled: connection.jitEnabled,
    mfaRequired: connection.mfaRequired,
    maxSessionSeconds: connection.maxSessionSeconds,
    idleTimeoutSeconds: connection.idleTimeoutSeconds,
    config: connection.config,
    attributeMapping: connection.attributeMapping,
  }
}

/** Seconds, null, or invalid. At least five minutes, at most ninety days. */
function seconds(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value)) return "invalid"
  return value >= 300 && value <= 90 * 24 * 3600 ? value : "invalid"
}

/** The PATCH body as a patch, or a message saying what is wrong with it. */
export function readPatch(body: Record<string, unknown>): ConnectionPatch | string {
  const patch: ConnectionPatch = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)
      return "name must be 1 to 100 characters."
    patch.name = body.name.trim()
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as ConnectionStatus))
      return "status is not valid."
    patch.status = body.status as ConnectionStatus
  }
  if (body.enforcement !== undefined) {
    if (!ENFORCEMENTS.includes(body.enforcement as Enforcement))
      return "enforcement is not valid."
    patch.enforcement = body.enforcement as Enforcement
  }
  for (const key of ["jitEnabled", "mfaRequired"] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== "boolean") return `${key} must be true or false.`
    patch[key] = body[key]
  }
  for (const key of ["maxSessionSeconds", "idleTimeoutSeconds"] as const) {
    const value = seconds(body[key])
    if (value === "invalid") return `${key} must be null or 300 to 7776000 seconds.`
    if (value !== undefined) patch[key] = value
  }
  if (body.attributeMapping !== undefined) {
    const m = body.attributeMapping
    if (
      !m ||
      typeof m !== "object" ||
      Array.isArray(m) ||
      Object.values(m).some((v) => typeof v !== "string")
    )
      return "attributeMapping must map names to names."
    patch.attributeMapping = m as Record<string, string>
  }
  return patch
}

export function mountIdentity(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }
  /** Whether the signed-in person may act on `member` as removing them would. */
  const outranked = async (c: Context, member: string) => {
    if (!d.roles) return "forbidden" as const
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const [actor, target] = await Promise.all([
      d.roles.store.roleOf(tenantId, userId),
      d.roles.store.roleOf(tenantId, member),
    ])
    return mayRemove(actor ?? "member", target ?? "member")
  }

  app.get("/identity/connections", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const { tenantId } = c.get("auth")
    const rows = await id.store.connections(tenantId)
    return c.json({
      data: rows.map((r) => ({ ...view(r), domains: r.domains })),
      protocols: id.protocols,
    })
  })

  app.post("/identity/connections", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can change SSO settings."), 403)
    const body = (await readJson(c)) ?? {}
    const name = typeof body.name === "string" ? body.name.trim() : ""
    const protocol = body.protocol as Protocol
    const provider =
      typeof body.provider === "string" ? body.provider.trim() : "generic"
    if (!name || name.length > 100)
      return c.json(validation("name must be 1 to 100 characters."), 422)
    /*
     * ⚠ ONLY A PROTOCOL THIS PROCESS HAS AN ENGINE FOR. `test` exists only
     * where the test engine is on; OIDC and SAML arrive with #338 and #339.
     */
    if (!PROTOCOLS.includes(protocol) || !id.protocols.includes(protocol))
      return c.json(validation("That protocol is not available."), 422)
    if (!/^[a-z0-9_-]{1,32}$/.test(provider))
      return c.json(validation("provider is not valid."), 422)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const made = await id.store.createConnection(tenantId, {
      name,
      protocol,
      provider,
      createdBy: userId,
    })
    await id.store.record(tenantId, {
      type: "connection.created",
      actorUserId: userId,
      connectionId: made.id,
      data: { protocol, provider, name },
    })
    return c.json(view(made), 201)
  })

  app.patch("/identity/connections/:id", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can change SSO settings."), 403)
    const connectionId = c.req.param("id")
    if (!UUID.test(connectionId)) return c.json(notFound(), 404)
    const patch = readPatch((await readJson(c)) ?? {})
    if (typeof patch === "string") return c.json(validation(patch), 422)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const before = await id.store.connection(tenantId, connectionId)
    if (!before) return c.json(notFound(), 404)
    /*
     * ⚠ ACTIVATING NEEDS A LIVE DOMAIN. A connection with no domain would sign
     * nobody in, and one whose proof was displaced would claim accounts it no
     * longer has any right to.
     */
    if (patch.status === "active" && before.status !== "active") {
      if ((await id.store.liveDomains(tenantId, connectionId)).length === 0)
        return c.json(
          validation("Add a verified access domain before activating."),
          422,
        )
    }
    const after = await id.store.updateConnection(tenantId, connectionId, patch)
    if (!after) return c.json(notFound(), 404)
    await id.store.record(tenantId, {
      type: "connection.updated",
      actorUserId: userId,
      connectionId,
      data: {
        changed: Object.keys(patch),
        from: pick(view(before), patch),
        to: pick(view(after), patch),
      },
    })
    return c.json(view(after))
  })

  app.post("/identity/connections/:id/domains", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO connections"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can change SSO settings."), 403)
    const connectionId = c.req.param("id")
    const body = (await readJson(c)) ?? {}
    const joinDomainId = typeof body.joinDomainId === "string" ? body.joinDomainId : ""
    if (!UUID.test(connectionId) || !UUID.test(joinDomainId))
      return c.json(
        validation("joinDomainId must be one of this workspace's access domains."),
        422,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const added = await id.store.addDomain(tenantId, connectionId, joinDomainId)
    if (added === "not_found")
      return c.json(validation("Use a verified access domain of this workspace."), 422)
    if (added === "taken")
      return c.json(
        {
          statusCode: 409,
          name: "conflict",
          message: "Another connection covers that domain.",
        },
        409,
      )
    await id.store.record(tenantId, {
      type: "connection.domain_added",
      actorUserId: userId,
      connectionId,
      data: { joinDomainId },
    })
    return c.json({ ok: true })
  })

  app.delete(
    "/identity/connections/:id/domains/:domainId",
    requireFreshAuth,
    async (c) => {
      const id = d.identity
      if (!id) return c.json(notWired("SSO connections"), 501)
      if (!(await allowed(c, "sso:manage")))
        return c.json(forbidden("Only an admin can change SSO settings."), 403)
      const connectionId = c.req.param("id")
      const joinDomainId = c.req.param("domainId")
      if (!UUID.test(connectionId) || !UUID.test(joinDomainId))
        return c.json(notFound(), 404)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      if (!(await id.store.removeDomain(tenantId, connectionId, joinDomainId)))
        return c.json(notFound(), 404)
      await id.store.record(tenantId, {
        type: "connection.domain_removed",
        actorUserId: userId,
        connectionId,
        data: { joinDomainId },
      })
      return c.json({ ok: true })
    },
  )

  app.get("/identity/settings", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO settings"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const { tenantId } = c.get("auth")
    return c.json({ deprovision: await id.store.deprovisionMode(tenantId) })
  })

  app.put("/identity/settings", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO settings"), 501)
    /*
     * ⚠ AN OWNER'S CHOICE, NOT AN ADMIN'S. `account` makes deprovisioning a
     * ban of the whole i10 account, everywhere; who may set that is who may
     * hand the workspace on.
     */
    if (!(await allowed(c, "owners:manage")))
      return c.json(
        forbidden("Only an owner can change what deprovisioning does."),
        403,
      )
    const body = (await readJson(c)) ?? {}
    if (body.deprovision !== "membership" && body.deprovision !== "account")
      return c.json(validation("deprovision must be membership or account."), 422)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const before = await id.store.deprovisionMode(tenantId)
    await id.store.setDeprovisionMode(tenantId, body.deprovision, userId)
    await id.store.record(tenantId, {
      type: "settings.updated",
      actorUserId: userId,
      data: { deprovision: { from: before, to: body.deprovision } },
    })
    return c.json({ deprovision: body.deprovision })
  })

  app.get("/identity/events", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("The identity audit log"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see the identity audit log."), 403)
    const { tenantId } = c.get("auth")
    const limit = Number(c.req.query("limit") ?? 50)
    const subject = c.req.query("user")
    const rows = await id.store.events(tenantId, {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(subject ? { subjectUserId: subject } : {}),
    })
    return c.json({ data: rows })
  })

  // ── A member's sessions (sso.md 2.5) ──────────────────────────────────────

  app.get("/identity/members/:userId/sessions", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("Member sessions"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const member = c.req.param("userId")
    // ⚠ YOUR OWN SESSIONS ARE YOURS TO SEE; ANYBODY ELSE'S NEED `members:manage`.
    if (member !== userId && !(await allowed(c, "members:manage")))
      return c.json(forbidden("Only an admin can see a member's sessions."), 403)
    const rows = await id.store.sessionsOf(tenantId, member)
    return c.json({
      data: rows.map((s) => ({
        sessionId: s.sessionId,
        connectionId: s.connectionId,
        boundAt: s.boundAt,
        freshAt: s.freshAt,
        lastSeenAt: s.lastSeenAt,
      })),
    })
  })

  app.post("/identity/members/:userId/sessions/:sessionId/revoke", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("Member sessions"), 501)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const member = c.req.param("userId")
    const sessionId = c.req.param("sessionId")
    if (!SESSION_ID.test(sessionId)) return c.json(notFound(), 404)
    // ⚠ ENDING SOMEBODY ELSE'S SESSION OBEYS THE RULE REMOVING THEM DOES: an
    // admin cannot sign an owner out.
    if (member !== userId && (await outranked(c, member)) !== "ok")
      return c.json(forbidden("You cannot end this person's sessions."), 403)
    const row = await id.store.sessionRow(tenantId, sessionId)
    if (!row || row.clerkUserId !== member || row.revokedAt)
      return c.json(notFound(), 404)
    // ⚠ CLERK FIRST: our row says revoked only once Clerk agreed.
    await id.clerk.revokeSession(sessionId)
    await id.store.revokeSessionRow(tenantId, sessionId, "admin", new Date())
    id.gate.forget({ userId: member, sessionId })
    await id.store.record(tenantId, {
      type: "session.revoked",
      actorUserId: userId,
      subjectUserId: member,
      sessionId,
      connectionId: row.connectionId,
      reason: "admin",
    })
    return c.json({ ok: true })
  })

  app.post("/identity/members/:userId/deprovision", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("Deprovisioning"), 501)
    if (!(await allowed(c, "members:manage")))
      return c.json(forbidden("Only an admin can deprovision a member."), 403)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const member = c.req.param("userId")
    if (member === userId)
      return c.json(
        validation("Leave the workspace instead of deprovisioning yourself."),
        422,
      )
    const done = await deprovision(id.deprovision, {
      tenantId,
      clerkUserId: member,
      actorUserId: userId,
      cause: "admin",
    })
    id.gate.forget({ userId: member })
    switch (done.outcome) {
      case "membership":
      case "account":
        return c.json(done)
      case "not_managed":
        return c.json(notFound("That person is not managed by this workspace."), 404)
      case "forbidden":
      case "owner_only":
        return c.json(forbidden("You cannot deprovision this person."), 403)
      case "last_owner":
        return c.json(
          {
            statusCode: 409,
            name: "last_owner",
            message: "A workspace needs an owner.",
          },
          409,
        )
      case "unconfirmed":
      case "workspace_gone":
        return c.json(
          {
            statusCode: 503,
            name: "service_unavailable",
            message: "Try again in a minute.",
          },
          503,
        )
    }
  })
}

function pick(
  view: Record<string, unknown>,
  patch: ConnectionPatch,
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, view[k]]))
}
