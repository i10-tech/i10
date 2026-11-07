import type { Context, Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import type { Connection } from "../../identity/model.js"
import { storedLdap } from "../../identity/ldap.js"
import type { OidcFetch } from "../../identity/oidc-fetch.js"
import {
  DiscoveryFailed,
  LEGACY_OKTA_MAIL_KEY,
  OIDC_MAIL_CATALOG,
  OIDC_MAIL_KEY,
  applyInput,
  completeOidcMail,
  defaultPresetFor,
  discoverTokenEndpoint,
  isOidcMailPreset,
  oidcMailInput,
  settingsProblem,
  storedExtra,
  storedOidcMail,
  type OidcMailPreset,
  type StoredOidcMail,
} from "../../identity/oidc-mail.js"

/**
 * A connection's OIDC mail sign-in (#383, B9): where authd asks the company's
 * own OpenID Connect provider (Okta, Keycloak, Auth0, PingFederate, FusionAuth,
 * or any other that takes a public client's password grant) about the password
 * of an account the connection manages, instead of asking Clerk.
 *
 *   GET /identity/connections/:id/oidc-mail   what is set, and the presets
 *   PUT /identity/connections/:id/oidc-mail   preset, issuer, clientId, extra,
 *                                             enabled (step-up)
 *
 * Nothing here is a secret (a URL, a public client id and a few plain form
 * fields), so there is no service-account route and no setup test that carries a
 * password. The customer admin's side - the public client, the `password` grant,
 * a password-only sign-in policy - is their provider's own console.
 *
 * ⚠ THE TRUST RULE (sso.md 2.14), HARDER THAN LDAP'S: the token endpoint is where
 * every managed member's mail password is POSTed, so a server of an attacker's
 * choosing is a password harvester. Changing a setting or turning this ON is
 * `owners:manage` and step-up, whatever the connection's status. The one move an
 * admin keeps is turning it OFF, which removes a way in rather than adding one.
 *
 * ⚠ THE TOKEN ENDPOINT IS READ FROM THE ISSUER'S DISCOVERY DOCUMENT, HERE, ONCE
 * PER SAVE, and never typed by anyone: through the egress guard, on the issuer's
 * own host, from a provider that lists the password grant (identity/oidc-mail.ts,
 * `discoverTokenEndpoint`). The network call is made BEFORE the row lock, so a
 * slow provider holds nothing; the lock then checks that the issuer it was read
 * for is still the one being saved.
 *
 * ⚠ ANY CHANGE TURNS IT OFF. A different issuer, preset, client id or field is a
 * different place or way for passwords to go, so it takes an explicit
 * `enabled: true` (the same request may carry it). Enabling needs the settings
 * whole, and a connection whose LDAP pass-through is on is refused: a connection
 * asks its members' passwords of ONE place. identity-ldap.ts refuses the other
 * direction; both check under the connection's row lock, so two requests at once
 * cannot leave both on.
 *
 * ⚠ A CHANGE REACHES CACHED PASSWORDS AT ONCE. authd remembers a success for
 * minutes (passthrough.OIDCMaxCacheTTL), so every change raises the credential
 * epoch of the connection's managed accounts (`invalidate`).
 *
 * ⚠ A LEGACY OKTA-ONLY ROW (`config.oktaMail`) IS READ AND REPLACED. The first
 * write of any kind stores `oidcMail` and drops the old key, in the same save.
 */

export interface OidcMailConsoleDeps {
  /**
   * Makes authd ask the provider again for every account the connection
   * manages. Called after the change is saved; a failure is logged and recorded,
   * never undone.
   */
  invalidate(connectionId: string): Promise<void>
  /** `guardedFetch`: the only way this route reaches a provider. */
  fetch: OidcFetch
}

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

/** The state refuses the move; the caller can fix it and retry. */
const conflict = (reason: string, message: string) =>
  ({ statusCode: 409, name: "oidc_mail_refused" as const, reason, message }) as const

/** The provider could not be asked; nothing is wrong with the request. */
const unreachable = (message: string) =>
  ({ statusCode: 503, name: "idp_unreachable" as const, message }) as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class OidcMailRefused extends Error {
  constructor(
    readonly reason: "not_supported" | "incomplete" | "ldap_enabled" | "stale",
  ) {
    super(reason)
    this.name = "OidcMailRefused"
  }
}

/** A setting that is not valid for its preset. Answered 422 with the words. */
class SettingsInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsInvalid"
  }
}

/** The row, read under the lock, needs an owner to change as asked. */
class NotAnOwner extends Error {
  constructor() {
    super("not an owner")
    this.name = "NotAnOwner"
  }
}

const REFUSALS: Record<OidcMailRefused["reason"], string> = {
  not_supported:
    "This connection's provider has no OIDC mail sign-in. Entra and Google have their own, and OneLogin's password grant needs a client secret, which i10 does not hold.",
  incomplete: "Set the issuer and the client id first.",
  ldap_enabled:
    "Turn LDAP pass-through off first. A connection asks its members' passwords of one place.",
  stale: "The settings changed while they were being checked. Try again.",
}

function view(connection: Connection): Record<string, unknown> {
  const s = storedOidcMail(connection)
  const fallback = defaultPresetFor(connection.provider)
  return {
    preset: isOidcMailPreset(s.preset) ? s.preset : fallback,
    defaultPreset: fallback,
    presets: OIDC_MAIL_CATALOG,
    issuer: s.issuer ?? null,
    clientId: s.clientId ?? null,
    tokenEndpoint: s.tokenEndpoint ?? null,
    extra: storedExtra(s.extra) ?? {},
    enabled: s.enabled === true,
    available: fallback !== null,
    ldapEnabled: storedLdap(connection).enabled === true,
  }
}

/** Whether the change needs the token endpoint read again. */
const needsDiscovery = (changed: readonly string[], next: StoredOidcMail) =>
  next.issuer !== undefined &&
  changed.some((k) => k === "issuer" || k === "preset" || k === "extra")

export function mountIdentityOidcMail(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  /** The connection the route names, or the response that says why not. */
  const load = async (c: Context) => {
    const id = d.identity
    if (!id?.oidcMail) return { error: c.json(notWired("OIDC mail sign-in"), 501) }
    if (!(await allowed(c, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can change SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection) return { error: c.json(notFound(), 404) }
    return { id, oidcMail: id.oidcMail, connection, tenantId }
  }

  app.get("/identity/connections/:id/oidc-mail", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return c.json(view(loaded.connection))
  })

  app.put("/identity/connections/:id/oidc-mail", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, oidcMail, connection, tenantId } = loaded
    const parsed = oidcMailInput.safeParse((await readJson(c)) ?? null)
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid settings."),
        422,
      )
    const input = parsed.data
    if (Object.keys(input).length === 0)
      return c.json(validation("Send at least one setting to change."), 422)

    const { userId } = c.get("user")
    const refuse = async (reason: OidcMailRefused["reason"]) => {
      await id.store.record(tenantId, {
        type: "connection.oidc_mail_refused",
        actorUserId: userId,
        connectionId: connection.id,
        reason,
        data: { status: connection.status },
      })
      return c.json(conflict(reason, REFUSALS[reason]), 409)
    }
    const fallback: OidcMailPreset | null = defaultPresetFor(connection.provider)
    if (fallback === null) return refuse("not_supported")

    const before = storedOidcMail(connection)
    const pre = applyInput(before, input, fallback)
    const loosens = pre.changed.length > 0 || input.enabled === true
    /*
     * ⚠ AN OWNER'S, ON EVERY STATUS: the token endpoint decides where passwords
     * go. Turning it OFF alone stays an admin's.
     *
     * Asked here, from the row as it was read, so a refusal costs no lock and no
     * outbound request; and again under the lock below, from the row as it is,
     * so a change that landed in between cannot turn an admin's "same value"
     * into a different one.
     */
    const owner = await allowed(c, "owners:manage")
    const notAnOwner = () =>
      c.json(
        forbidden(
          "Only an owner can change which provider a connection's members' mail passwords are checked against.",
        ),
        403,
      )
    if (loosens && !owner) return notAnOwner()

    // A setting that is wrong for its preset is the owner's to hear before any
    // request leaves for the provider.
    if (pre.changed.length > 0) {
      const problem = settingsProblem(pre.next)
      if (problem) return c.json(validation(problem), 422)
    }

    /*
     * ⚠ THE PROVIDER IS ASKED HERE, BEFORE THE LOCK: a slow or silent issuer
     * must not hold the connection's row. What it answers is bound to the issuer
     * it was asked about, and the lock refuses to use it for another.
     */
    let discovered: { issuer: string; tokenEndpoint: string } | null = null
    if (needsDiscovery(pre.changed, pre.next)) {
      try {
        discovered = {
          issuer: pre.next.issuer!,
          tokenEndpoint: await discoverTokenEndpoint({
            issuer: pre.next.issuer!,
            preset: pre.next.preset as OidcMailPreset,
            extra: storedExtra(pre.next.extra) ?? {},
            fetch: oidcMail.fetch,
          }),
        }
      } catch (error) {
        if (!(error instanceof DiscoveryFailed)) throw error
        return error.kind === "unreachable"
          ? c.json(unreachable(error.message), 503)
          : c.json(validation(error.message), 422)
      }
    }

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
        const stored = storedOidcMail({
          config: cur.config,
          provider: connection.provider,
        })
        const { next, changed } = applyInput(stored, input, fallback)
        if ((changed.length > 0 || input.enabled === true) && !owner)
          throw new NotAnOwner()
        if (changed.length > 0) {
          const problem = settingsProblem(next)
          if (problem) throw new SettingsInvalid(problem)
          if (needsDiscovery(changed, next)) {
            if (!discovered || discovered.issuer !== next.issuer)
              throw new OidcMailRefused("stale")
            next.tokenEndpoint = discovered.tokenEndpoint
          }
          next.enabled = false
        }
        if (input.enabled !== undefined) {
          if (input.enabled) {
            if (storedLdap({ config: cur.config }).enabled === true)
              throw new OidcMailRefused("ldap_enabled")
            if (!completeOidcMail(next)) throw new OidcMailRefused("incomplete")
          }
          next.enabled = input.enabled
        }
        applied.changed = changed
        applied.before = stored.enabled === true
        applied.after = next.enabled === true
        applied.to = Object.fromEntries(
          [...changed, ...(needsDiscovery(changed, next) ? ["tokenEndpoint"] : [])].map(
            (k) => [k, (next as Record<string, unknown>)[k] ?? null],
          ),
        )
        // Spread what is there: other keys of the config are not this route's. The
        // legacy key goes in the same save that replaces it.
        const rest = Object.fromEntries(
          Object.entries(cur.config).filter(([k]) => k !== LEGACY_OKTA_MAIL_KEY),
        )
        return {
          secrets: cur.secrets,
          config: { ...rest, [OIDC_MAIL_KEY]: next },
        }
      })
    } catch (error) {
      if (error instanceof NotAnOwner) return notAnOwner()
      if (error instanceof SettingsInvalid)
        return c.json(validation(error.message), 422)
      if (!(error instanceof OidcMailRefused)) throw error
      return refuse(error.reason)
    }
    if (!after) return c.json(notFound(), 404)

    const moved = applied.changed.length > 0 || applied.before !== applied.after
    if (moved) {
      // ⚠ AFTER THE SAVE, AND NEVER UNDOING IT: the change is made. If the
      // epochs cannot be raised the cached passwords live out their minutes
      // (OIDCMaxCacheTTL), and that is on record rather than an error for the
      // admin to retry.
      let revoked = true
      try {
        await oidcMail.invalidate(connection.id)
      } catch (error) {
        revoked = false
        id.log.error(
          {
            connectionId: connection.id,
            err: error instanceof Error ? error.name : "unknown",
          },
          "could not raise the credential epoch after an OIDC mail change",
        )
      }
      await id.store.record(tenantId, {
        type: "connection.oidc_mail_updated",
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
