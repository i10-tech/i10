import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import {
  can,
  parseJoinRole,
  type JoinRole,
  type Permission,
} from "../../console/roles.js"
import { OWNER_GUARDED } from "../../identity/model.js"
import { MAX_GROUP_RULES, readGroupValue, readPrecedence } from "../../identity/jit.js"
import type { GroupRoleRule } from "../../identity/ports.js"

/**
 * A connection's group-to-role rules (#341, sso.md 2.6), for the setup screen.
 *
 *   GET    /identity/connections/:id/group-rules           first by precedence
 *   POST   /identity/connections/:id/group-rules           { group, role, precedence } (step-up)
 *   PATCH  /identity/connections/:id/group-rules/:ruleId   any of them (step-up)
 *   DELETE /identity/connections/:id/group-rules/:ruleId   (step-up)
 *
 * ⚠ RULES GRANT ROLES, SO ON A LIVE CONNECTION THEY ARE AN OWNER'S (the trust
 * rule of sso.md 2.14). A rule decides who becomes an admin at their next
 * sign-in, and whoever runs the IdP decides who is in which group; on an
 * `active` or `disabled` connection, any change needs `owners:manage` as well
 * as step-up. On `draft` and `testing`, `sso:manage` and step-up: nobody signs
 * in through them yet, and an admin can make admins anyway.
 *
 * ⚠ NEVER OWNER. A rule's role is member or admin (`parseJoinRole`), and the
 * table's own check refuses anything else.
 *
 * ⚠ EVERY CHANGE IS AUDITED with the actor and the rule before and after.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const conflict = (message: string) =>
  ({ statusCode: 409, name: "conflict" as const, message }) as const

function view(rule: GroupRoleRule) {
  return {
    id: rule.id,
    group: rule.groupValue,
    role: rule.role,
    precedence: rule.precedence,
  }
}

/** A rule from a request; `partial` for a PATCH, where every field is optional. */
export function readRule(
  body: Record<string, unknown>,
  partial: boolean,
): { groupValue?: string; role?: JoinRole; precedence?: number } | { error: string } {
  const out: { groupValue?: string; role?: JoinRole; precedence?: number } = {}
  for (const key of Object.keys(body))
    if (!["group", "role", "precedence"].includes(key))
      return { error: `${key} is not a rule field.` }
  if (body.group !== undefined || !partial) {
    const group = readGroupValue(body.group)
    if (!group) return { error: "group must be 1 to 256 characters." }
    out.groupValue = group
  }
  if (body.role !== undefined || !partial) {
    const role = parseJoinRole(body.role)
    if (!role) return { error: "role must be member or admin." }
    out.role = role
  }
  if (body.precedence !== undefined || !partial) {
    const precedence = readPrecedence(body.precedence)
    if (precedence === null)
      return { error: "precedence must be a whole number from 0 to 10000." }
    out.precedence = precedence
  }
  if (partial && Object.keys(out).length === 0)
    return { error: "Change the group, the role or the precedence." }
  return out
}

export function mountIdentityGroups(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  /**
   * The connection a change is for, once the actor may change its rules; or
   * the refusal.
   */
  const guard = async (c: Context, connectionId: string) => {
    const id = d.identity!
    if (!(await allowed(c, "sso:manage")))
      return {
        refusal: c.json(forbidden("Only an admin can change SSO settings."), 403),
      }
    if (!UUID.test(connectionId)) return { refusal: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { refusal: c.json(notFound(), 404) }
    if (
      OWNER_GUARDED.includes(connection.status) &&
      !(await allowed(c, "owners:manage"))
    )
      return {
        refusal: c.json(
          forbidden(
            "Only an owner can change the group rules of an active connection.",
          ),
          403,
        ),
      }
    return { connection }
  }

  app.get("/identity/connections/:id/group-rules", async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO group rules"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see SSO settings."), 403)
    const connectionId = c.req.param("id")
    if (!UUID.test(connectionId)) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    if (!(await id.store.connection(tenantId, connectionId)))
      return c.json(notFound(), 404)
    const rules = await id.store.groupRules(tenantId, connectionId)
    return c.json({
      data: rules.map(view),
      defaultRole: "member",
      max: MAX_GROUP_RULES,
    })
  })

  app.post("/identity/connections/:id/group-rules", requireFreshAuth, async (c) => {
    const id = d.identity
    if (!id) return c.json(notWired("SSO group rules"), 501)
    const connectionId = c.req.param("id")
    const guarded = await guard(c, connectionId)
    if ("refusal" in guarded) return guarded.refusal
    const input = readRule((await readJson(c)) ?? {}, false)
    if ("error" in input) return c.json(validation(input.error), 422)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const made = await id.store.createGroupRule(tenantId, {
      connectionId,
      groupValue: input.groupValue!,
      role: input.role!,
      precedence: input.precedence!,
      createdBy: userId,
    })
    if (made === "not_found") return c.json(notFound(), 404)
    if (made === "exists")
      return c.json(conflict("That group already has a rule on this connection."), 409)
    if (made === "too_many")
      return c.json(
        validation(`A connection can have at most ${MAX_GROUP_RULES} group rules.`),
        422,
      )
    await id.store.record(tenantId, {
      type: "group_rule.created",
      actorUserId: userId,
      connectionId,
      data: { rule: view(made) },
    })
    return c.json(view(made), 201)
  })

  app.patch(
    "/identity/connections/:id/group-rules/:ruleId",
    requireFreshAuth,
    async (c) => {
      const id = d.identity
      if (!id) return c.json(notWired("SSO group rules"), 501)
      const connectionId = c.req.param("id")
      const ruleId = c.req.param("ruleId")
      const guarded = await guard(c, connectionId)
      if ("refusal" in guarded) return guarded.refusal
      if (!UUID.test(ruleId)) return c.json(notFound(), 404)
      const patch = readRule((await readJson(c)) ?? {}, true)
      if ("error" in patch) return c.json(validation(patch.error), 422)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const before = (await id.store.groupRules(tenantId, connectionId)).find(
        (r) => r.id === ruleId,
      )
      if (!before) return c.json(notFound(), 404)
      const after = await id.store.updateGroupRule(
        tenantId,
        connectionId,
        ruleId,
        patch,
      )
      if (after === null) return c.json(notFound(), 404)
      if (after === "exists")
        return c.json(
          conflict("That group already has a rule on this connection."),
          409,
        )
      await id.store.record(tenantId, {
        type: "group_rule.updated",
        actorUserId: userId,
        connectionId,
        data: { from: view(before), to: view(after) },
      })
      return c.json(view(after))
    },
  )

  app.delete(
    "/identity/connections/:id/group-rules/:ruleId",
    requireFreshAuth,
    async (c) => {
      const id = d.identity
      if (!id) return c.json(notWired("SSO group rules"), 501)
      const connectionId = c.req.param("id")
      const ruleId = c.req.param("ruleId")
      const guarded = await guard(c, connectionId)
      if ("refusal" in guarded) return guarded.refusal
      if (!UUID.test(ruleId)) return c.json(notFound(), 404)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const gone = await id.store.deleteGroupRule(tenantId, connectionId, ruleId)
      if (!gone) return c.json(notFound(), 404)
      await id.store.record(tenantId, {
        type: "group_rule.deleted",
        actorUserId: userId,
        connectionId,
        data: { rule: view(gone) },
      })
      return c.json({ ok: true })
    },
  )
}
