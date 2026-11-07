import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import type { Connection } from "../../identity/model.js"
import {
  CREDENTIAL_EVENT_TYPES,
  mintHookSecret,
  storedOktaHook,
} from "../../identity/okta-event-hook.js"

/**
 * An Okta connection's event hook (#383, B9 step 2b), for the setup screen:
 * the secret Okta sends so we can raise a person's mail credential epoch when
 * their Okta account changes (identity/okta-event-hook.ts).
 *
 *   GET    /identity/connections/:id/okta-event-hook         the URL, the header, what is set (admin)
 *   POST   /identity/connections/:id/okta-event-hook/secret  make or rotate the secret (owner, step-up)
 *   DELETE /identity/connections/:id/okta-event-hook/secret  turn the hook off (owner, step-up)
 *
 * ⚠ THE SECRET IS SHOWN ONCE, IN THE RESPONSE THAT MAKES IT. Only its SHA-256
 * is kept, so nothing can show it again; losing it means making another.
 * Rotating replaces the old secret at once, so the owner pastes the new one
 * into Okta straight away (events in between are retried by Okta once and
 * then lost, which costs at most a cached password living out its cache).
 *
 * ⚠ OWNER ONLY, ON EVERY STATUS. The hook does not decide who gets in, but a
 * holder of the secret can make authd re-ask Okta about any person on the
 * connection, so it is held to the rule of the other connection credentials.
 */

export interface OktaHookConsoleDeps {
  /** Where Okta sends events for a connection: this API's `/webhooks/okta/<id>`. */
  url(connectionId: string): string
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

/** What the screen needs, and never the hash. */
function view(connection: Connection, hook: OktaHookConsoleDeps) {
  const stored = storedOktaHook(connection)
  return {
    url: hook.url(connection.id),
    // The "authentication field" the admin types into Okta.
    header: "Authorization",
    secretSet: stored.secretHash !== undefined,
    hint: stored.secretHash ? (stored.hint ?? null) : null,
    issuedAt: stored.secretHash ? (stored.issuedAt ?? null) : null,
    // What to subscribe the hook to.
    events: [...CREDENTIAL_EVENT_TYPES],
  }
}

export function mountIdentityOktaHook(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }
  const clock = () => (d.identity?.oktaHook?.now ?? (() => new Date()))()

  /** The Okta connection the route names, or the response that says why not. */
  const load = async (c: Context, permission: Permission) => {
    const id = d.identity
    const hook = id?.oktaHook
    if (!id || !hook) return { error: c.json(notWired("Okta event hooks"), 501) }
    if (!(await allowed(c, permission)))
      return {
        error: c.json(
          forbidden(
            permission === "owners:manage"
              ? "Only an owner can change an Okta event hook."
              : "Only an admin can see SSO settings.",
          ),
          403,
        ),
      }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { error: c.json(notFound(), 404) }
    // ⚠ OKTA ONLY: the endpoint answers for no other provider, so a secret
    // stored on one would be a credential that opens nothing.
    if (connection.provider !== "okta")
      return {
        error: c.json(validation("Event hooks are only available for Okta."), 422),
      }
    return { id, hook, connection, tenantId }
  }

  app.get("/identity/connections/:id/okta-event-hook", async (c) => {
    const loaded = await load(c, "sso:manage")
    if ("error" in loaded) return loaded.error
    return c.json(view(loaded.connection, loaded.hook))
  })

  app.post(
    "/identity/connections/:id/okta-event-hook/secret",
    requireFreshAuth,
    async (c) => {
      const loaded = await load(c, "owners:manage")
      if ("error" in loaded) return loaded.error
      const { id, hook, connection, tenantId } = loaded
      const made = mintHookSecret(clock())
      const was = { set: false }
      // ⚠ UNDER THE ROW LOCK: this edits one key of a config other settings
      // write too, and a read outside the lock would write theirs away.
      const after = await id.store.setConnectionSecrets(
        tenantId,
        connection.id,
        (cur) => {
          was.set = storedOktaHook({ config: cur.config }).secretHash !== undefined
          return {
            secrets: cur.secrets,
            config: { ...cur.config, oktaEventHook: made.stored },
          }
        },
      )
      if (!after) return c.json(notFound(), 404)
      const { userId } = c.get("user")
      await id.store.record(tenantId, {
        type: "connection.secret_set",
        actorUserId: userId,
        connectionId: connection.id,
        // ⚠ THAT IT CHANGED, NEVER WHAT TO.
        data: { kind: "okta_event_hook", rotated: was.set, status: connection.status },
      })
      c.header("Cache-Control", "no-store")
      return c.json({ ...view(after, hook), secret: made.secret }, 201)
    },
  )

  app.delete(
    "/identity/connections/:id/okta-event-hook/secret",
    requireFreshAuth,
    async (c) => {
      const loaded = await load(c, "owners:manage")
      if ("error" in loaded) return loaded.error
      const { id, hook, connection, tenantId } = loaded
      const was = { set: false }
      const after = await id.store.setConnectionSecrets(
        tenantId,
        connection.id,
        (cur) => {
          was.set = storedOktaHook({ config: cur.config }).secretHash !== undefined
          const config = { ...cur.config }
          delete config.oktaEventHook
          return { secrets: cur.secrets, config }
        },
      )
      if (!after) return c.json(notFound(), 404)
      if (was.set) {
        const { userId } = c.get("user")
        await id.store.record(tenantId, {
          type: "connection.secret_revoked",
          actorUserId: userId,
          connectionId: connection.id,
          data: { kind: "okta_event_hook", status: connection.status },
        })
      }
      return c.json(view(after, hook))
    },
  )
}
