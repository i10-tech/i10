import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import type { Connection } from "../../identity/model.js"
import { storedLdap } from "../../identity/ldap.js"
import {
  OKTA_MAIL_FIELDS,
  OKTA_MAIL_KEY,
  completeOktaMail,
  oktaMailInput,
  storedOktaMail,
  type OktaMailInput,
  type StoredOktaMail,
} from "../../identity/okta-mail.js"

/**
 * A connection's Okta mail sign-in (#383, B9): where authd asks Okta about the
 * password of an account the connection manages, instead of asking Clerk.
 *
 *   GET /identity/connections/:id/okta-mail   what is set
 *   PUT /identity/connections/:id/okta-mail   issuer, clientId, enabled (step-up)
 *
 * Nothing here is a secret (a URL and a public client id), so there is no
 * service-account route and no setup test that carries a password. The customer
 * admin's side - the native app, the `password` grant, the password-only
 * sign-in policy - is Okta's own console.
 *
 * ⚠ THE TRUST RULE (sso.md 2.14), HARDER THAN LDAP'S: the issuer is where every
 * managed member's mail password is POSTed, so a server of an attacker's
 * choosing is a password harvester. Changing a setting or turning this ON is
 * `owners:manage` and step-up, whatever the connection's status. The one move an
 * admin keeps is turning it OFF, which removes a way in rather than adding one.
 *
 * ⚠ ANY CHANGE TURNS IT OFF. A different issuer or client id is a different
 * place for passwords to go, so it takes an explicit `enabled: true` (the same
 * request may carry it). Enabling needs both settings, and a connection whose
 * LDAP pass-through is on is refused: a connection asks its members' passwords
 * of ONE place. identity-ldap.ts refuses the other direction; both check under
 * the connection's row lock, so two requests at once cannot leave both on.
 *
 * ⚠ A CHANGE REACHES CACHED PASSWORDS AT ONCE. authd remembers an Okta success
 * for minutes (passthrough.OktaMaxCacheTTL), so every change raises the
 * credential epoch of the connection's managed accounts (`invalidate`).
 */

export interface OktaMailConsoleDeps {
  /**
   * Makes authd ask Okta again for every account the connection manages. Called
   * after the change is saved; a failure is logged and recorded, never undone.
   */
  invalidate(connectionId: string): Promise<void>
}

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

/** The state refuses the move; the caller can fix it and retry. */
const conflict = (reason: string, message: string) =>
  ({ statusCode: 409, name: "okta_mail_refused" as const, reason, message }) as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class OktaMailRefused extends Error {
  constructor(readonly reason: "not_okta" | "incomplete" | "ldap_enabled") {
    super(reason)
    this.name = "OktaMailRefused"
  }
}

/** The row, read under the lock, needs an owner to change as asked. */
class NotAnOwner extends Error {
  constructor() {
    super("not an owner")
    this.name = "NotAnOwner"
  }
}

const REFUSALS: Record<OktaMailRefused["reason"], string> = {
  not_okta: "Okta mail sign-in is only for Okta connections.",
  incomplete: "Set the issuer and the client id first.",
  ldap_enabled:
    "Turn LDAP pass-through off first. A connection asks its members' passwords of one place.",
}

function view(connection: Connection): Record<string, unknown> {
  const s = storedOktaMail(connection)
  return {
    issuer: s.issuer ?? null,
    clientId: s.clientId ?? null,
    enabled: s.enabled === true,
    available: connection.provider === "okta",
    ldapEnabled: storedLdap(connection).enabled === true,
  }
}

/** The settings in the body that differ from what is stored. */
function changedSettings(input: OktaMailInput, current: StoredOktaMail): string[] {
  return OKTA_MAIL_FIELDS.filter(
    (k) => input[k] !== undefined && input[k] !== (current[k] ?? null),
  )
}

export function mountIdentityOktaMail(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  /** The connection the route names, or the response that says why not. */
  const load = async (c: Context) => {
    const id = d.identity
    if (!id?.oktaMail) return { error: c.json(notWired("Okta mail sign-in"), 501) }
    if (!(await allowed(c, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can change SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { error: c.json(notFound(), 404) }
    return { id, oktaMail: id.oktaMail, connection, tenantId }
  }

  app.get("/identity/connections/:id/okta-mail", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return c.json(view(loaded.connection))
  })

  app.put("/identity/connections/:id/okta-mail", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, oktaMail, connection, tenantId } = loaded
    const parsed = oktaMailInput.safeParse((await readJson(c)) ?? null)
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid settings."),
        422,
      )
    const input = parsed.data
    if (Object.keys(input).length === 0)
      return c.json(validation("Send at least one setting to change."), 422)

    const { userId } = c.get("user")
    const refuse = async (reason: OktaMailRefused["reason"]) => {
      await id.store.record(tenantId, {
        type: "connection.okta_mail_refused",
        actorUserId: userId,
        connectionId: connection.id,
        reason,
        data: { status: connection.status },
      })
      return c.json(conflict(reason, REFUSALS[reason]), 409)
    }
    if (connection.provider !== "okta") return refuse("not_okta")

    const before = storedOktaMail(connection)
    const loosens = changedSettings(input, before).length > 0 || input.enabled === true
    /*
     * ⚠ AN OWNER'S, ON EVERY STATUS: the issuer decides where passwords go.
     * Turning it OFF alone stays an admin's.
     *
     * Asked here, from the row as it was read, so a refusal costs no lock; and
     * again under the lock below, from the row as it is, so a change that landed
     * in between cannot turn an admin's "same value" into a different one.
     */
    const owner = await allowed(c, "owners:manage")
    const notAnOwner = () =>
      c.json(
        forbidden(
          "Only an owner can change which Okta org a connection's members' mail passwords are checked against.",
        ),
        403,
      )
    if (loosens && !owner) return notAnOwner()

    // Filled in the lock's callback; an object, so the reads below see it.
    const applied = {
      changed: [] as string[],
      before: false,
      after: false,
      to: {} as Record<string, unknown>,
    }
    let after: Connection | null
    try {
      after = await id.store.setConnectionSecrets(tenantId, connection.id, (cur) => {
        const stored = storedOktaMail({ config: cur.config })
        const moved = changedSettings(input, stored)
        if ((moved.length > 0 || input.enabled === true) && !owner)
          throw new NotAnOwner()
        // Spread what is there: other keys of the object are not this route's.
        const next: StoredOktaMail = { ...stored }
        for (const k of OKTA_MAIL_FIELDS)
          if (input[k] !== undefined) Object.assign(next, { [k]: input[k] })
        if (moved.length > 0) next.enabled = false
        if (input.enabled !== undefined) {
          if (input.enabled) {
            if (storedLdap({ config: cur.config }).enabled === true)
              throw new OktaMailRefused("ldap_enabled")
            if (!completeOktaMail(next)) throw new OktaMailRefused("incomplete")
          }
          next.enabled = input.enabled
        }
        applied.changed = moved
        applied.before = stored.enabled === true
        applied.after = next.enabled === true
        applied.to = Object.fromEntries(
          moved.map((k) => [k, (next as Record<string, unknown>)[k] ?? null]),
        )
        return {
          secrets: cur.secrets,
          config: { ...cur.config, [OKTA_MAIL_KEY]: next },
        }
      })
    } catch (error) {
      if (error instanceof NotAnOwner) return notAnOwner()
      if (!(error instanceof OktaMailRefused)) throw error
      return refuse(error.reason)
    }
    if (!after) return c.json(notFound(), 404)

    const moved = applied.changed.length > 0 || applied.before !== applied.after
    if (moved) {
      // ⚠ AFTER THE SAVE, AND NEVER UNDOING IT: the change is made. If the
      // epochs cannot be raised the cached passwords live out their minutes
      // (OktaMaxCacheTTL), and that is on record rather than an error for the
      // admin to retry.
      let revoked = true
      try {
        await oktaMail.invalidate(connection.id)
      } catch (error) {
        revoked = false
        id.log.error(
          {
            connectionId: connection.id,
            err: error instanceof Error ? error.name : "unknown",
          },
          "could not raise the credential epoch after an Okta mail change",
        )
      }
      await id.store.record(tenantId, {
        type: "connection.okta_mail_updated",
        actorUserId: userId,
        connectionId: connection.id,
        data: {
          changed: applied.changed,
          trust: loosens,
          status: connection.status,
          enabled: { from: applied.before, to: applied.after },
          to: applied.to,
          cachedPasswordsRevoked: revoked,
        },
      })
    }
    return c.json(view(after))
  })
}
