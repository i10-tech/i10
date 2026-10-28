import type { Context, Hono } from "hono"
import { isIP } from "node:net"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import { isPermittedAddress } from "../../webhooks/egress.js"
import { OWNER_GUARDED, type Connection } from "../../identity/model.js"
import {
  OidcMisconfigured,
  newSigningKey,
  oidcReady,
  sealedOidc,
  storedOidc,
  type OidcEngine,
  type StoredOidc,
} from "../../identity/oidc.js"
import {
  CLIENT_AUTH_METHODS,
  presetOf,
  type ClientAuthMethod,
  type OidcPreset,
} from "../../identity/oidc-presets.js"

/**
 * A connection's OIDC settings (#338), for the setup screen (#340).
 *
 *   GET  /identity/connections/:id/oidc         what to paste into the IdP, and what is set
 *   PUT  /identity/connections/:id/oidc         issuer, discovery URL, client id, auth method,
 *                                               scopes, acr values (step-up)
 *   PUT  /identity/connections/:id/oidc/secret  set or rotate the client secret (step-up)
 *   POST /identity/connections/:id/oidc/keys    make or rotate the private_key_jwt key (step-up)
 *
 * ⚠ WRITE-ONLY SECRETS. The client secret and the private key go into the
 * sealed `secrets` column and are never read back by any route; the config
 * only says THAT a secret is set (`clientSecretSet`) and which public keys
 * exist.
 *
 * ⚠ THE TRUST RULE (sso.md 2.14, decision 7's open item b, settled for #338).
 * Issuer, discovery URL, client id, client authentication, secret and keys
 * decide WHO the connection believes. Once a connection is `active` (or
 * `disabled`, which is an active connection paused, its managed accounts still
 * its own), changing any of them needs `owners:manage` as well as step-up, and
 * is audited with the actor. On `draft` and `testing`, `sso:manage` is enough:
 * nobody signs in through them. Moving an active or disabled connection back
 * to draft or testing needs an owner too (identity.ts), or an admin could
 * step around this rule by demoting, editing and reactivating.
 */

export interface OidcConsoleDeps {
  engine: OidcEngine
  /** Where the IdP fetches our public keys: apps/auth's `/sso/jwks/:id`. */
  jwksUrl(connectionId: string): string
  /**
   * Where the IdP's server sends a Logout Token (#345): this API's own
   * `/sso/oidc/backchannel/<id>`, not apps/auth's, because the IdP's call is
   * form-encoded and carries no browser.
   */
  backchannelLogoutUrl(connectionId: string): string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * ⚠ `mfaAcrValues` IS TRUST TOO: listing a weak `acr` as MFA-proving would
 * quietly undo "require MFA at the IdP" on a live connection.
 */
const TRUST_FIELDS = [
  "issuer",
  "discoveryUrl",
  "clientId",
  "clientAuth",
  "mfaAcrValues",
] as const

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

/**
 * An https URL an IdP may live at, or a message.
 *
 * ⚠ THE STRING CHECK IS NOT THE GUARD. It refuses what is obviously wrong
 * (http, credentials, a fragment, a bare name, a private IP literal) so the
 * admin hears it at once; the real check is the egress guard, which vets what
 * the name resolves to at every fetch.
 */
export function readIdpUrl(
  value: unknown,
  label: string,
  options: { query: boolean },
): string | { error: string } {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    return { error: `${label} must be an https URL.` }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return { error: `${label} must be an https URL.` }
  }
  if (url.protocol !== "https:") return { error: `${label} must use https.` }
  if (url.username || url.password)
    return { error: `${label} must not carry credentials.` }
  if (url.hash || value.includes("#"))
    return { error: `${label} must not have a fragment.` }
  if (!options.query && url.search) return { error: `${label} must not have a query.` }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
  if (isIP(host) ? !isPermittedAddress(host) : !host.includes("."))
    return { error: `${label} must name a public host.` }
  // `URL` normalises `https://idp.test` to `https://idp.test/`; an issuer is
  // compared as a string, so the admin's exact text is kept.
  return value.trim()
}

const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/
const TOKEN = /^[\x21-\x7E]{1,256}$/

function tokens(
  value: unknown,
  label: string,
  pattern: RegExp,
  max: number,
): string[] | { error: string } {
  if (!Array.isArray(value) || value.length > max)
    return { error: `${label} must be a list of at most ${max} values.` }
  if (!value.every((v): v is string => typeof v === "string" && pattern.test(v)))
    return { error: `${label} has a value that is not allowed.` }
  return [...new Set(value)]
}

/**
 * The PUT body merged over what is stored, or a message. Only fields present
 * in the body change.
 */
export function readOidcInput(
  body: Record<string, unknown>,
  preset: OidcPreset,
  current: StoredOidc,
): { next: StoredOidc; changed: string[] } | string {
  if (preset.id === "google")
    return "A Google Workspace connection uses i10's own Google client; there is nothing to set."
  const next: StoredOidc = { ...current }
  if (body.issuer !== undefined) {
    const issuer = readIdpUrl(body.issuer, "issuer", { query: false })
    if (typeof issuer !== "string") return issuer.error
    if (preset.issuerPattern && !preset.issuerPattern.test(issuer))
      return `issuer must look like ${preset.issuerHint}.`
    next.issuer = issuer
  }
  if (body.discoveryUrl !== undefined) {
    if (body.discoveryUrl === null || body.discoveryUrl === "") next.discoveryUrl = null
    else {
      const url = readIdpUrl(body.discoveryUrl, "discoveryUrl", { query: true })
      if (typeof url !== "string") return url.error
      next.discoveryUrl = url
    }
  }
  if (body.clientId !== undefined) {
    if (
      typeof body.clientId !== "string" ||
      !/^[\x21-\x7E]{1,255}$/.test(body.clientId)
    )
      return "clientId must be 1 to 255 visible characters."
    next.clientId = body.clientId
  }
  if (body.clientAuth !== undefined) {
    const method = body.clientAuth as ClientAuthMethod
    if (!CLIENT_AUTH_METHODS.includes(method) || !preset.clientAuth.includes(method))
      return `clientAuth must be one of ${preset.clientAuth.join(", ")}.`
    next.clientAuth = method
  }
  if (body.scopes !== undefined) {
    const scopes = tokens(body.scopes, "scopes", SCOPE, 20)
    if (!Array.isArray(scopes)) return scopes.error
    if (!scopes.includes("openid")) return "scopes must include openid."
    next.scopes = scopes
  }
  for (const key of ["acrValues", "mfaAcrValues"] as const) {
    if (body[key] === undefined) continue
    const values = tokens(body[key], key, TOKEN, 10)
    if (!Array.isArray(values)) return values.error
    next[key] = values
  }
  const changed = ([...TRUST_FIELDS, "scopes", "acrValues"] as const).filter(
    (k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(current[k] ?? null),
  )
  return { next, changed }
}

/** What the setup screen shows. Never a secret. */
export function oidcSetupView(
  connection: Connection,
  o: OidcConsoleDeps,
): Record<string, unknown> {
  const preset = presetOf(connection.provider)
  const stored = storedOidc(connection)
  return {
    provider: connection.provider,
    label: preset?.label ?? connection.provider,
    redirectUri:
      connection.provider === "google"
        ? o.engine.googleRedirectUri
        : o.engine.redirectUri,
    jwksUrl: o.jwksUrl(connection.id),
    // Our Google client is shared by every workspace and Google sends no Logout Token.
    backchannelLogoutUri:
      connection.provider === "google" ? null : o.backchannelLogoutUrl(connection.id),
    issuerHint: preset?.issuerHint ?? null,
    requires: preset?.requires ?? [],
    clientAuthMethods: preset?.clientAuth ?? [],
    defaults: { scopes: preset?.scopes ?? [] },
    issuer: stored.issuer ?? null,
    discoveryUrl: stored.discoveryUrl ?? null,
    clientId: stored.clientId ?? null,
    clientAuth: stored.clientAuth ?? null,
    scopes: stored.scopes ?? null,
    acrValues: stored.acrValues ?? [],
    mfaAcrValues: stored.mfaAcrValues ?? [],
    clientSecretSet: stored.clientSecretSet === true,
    keys: (stored.keys ?? []).map((k) => ({ kid: k.kid, createdAt: k.createdAt })),
    ready: oidcReady(connection, o.engine.google),
  }
}

export function mountIdentityOidc(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  /** The OIDC connection the route names, or the response that says why not. */
  const load = async (c: Context) => {
    const id = d.identity
    if (!id?.oidc) return { error: c.json(notWired("OIDC connections"), 501) }
    if (!(await allowed(c, "sso:manage")))
      return { error: c.json(forbidden("Only an admin can change SSO settings."), 403) }
    const connectionId = c.req.param("id") ?? ""
    if (!UUID.test(connectionId)) return { error: c.json(notFound(), 404) }
    const { tenantId } = c.get("auth")
    const connection = await id.store.connection(tenantId, connectionId)
    if (!connection || connection.protocol !== "oidc")
      return { error: c.json(notFound(), 404) }
    return { id, oidc: id.oidc, connection, tenantId }
  }

  /**
   * ⚠ THE TRUST RULE, in one place for all three writes. See the file header.
   */
  const trustRefusal = async (c: Context, connection: Connection) => {
    if (!OWNER_GUARDED.includes(connection.status)) return null
    if (await allowed(c, "owners:manage")) return null
    return c.json(
      forbidden(
        "Only an owner can change who an active connection trusts. Ask an owner, or disable the connection first and have an owner make the change.",
      ),
      403,
    )
  }

  app.get("/identity/connections/:id/oidc", async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return c.json(oidcSetupView(loaded.connection, loaded.oidc))
  })

  app.put("/identity/connections/:id/oidc", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return putOidcSettings(
      c,
      loaded,
      (await readJson(c)) ?? {},
      { userId: c.get("user").userId },
      () => trustRefusal(c, loaded.connection),
    )
  })

  app.put("/identity/connections/:id/oidc/secret", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    return putOidcSecret(
      c,
      loaded,
      (await readJson(c)) ?? {},
      { userId: c.get("user").userId },
      () => trustRefusal(c, loaded.connection),
    )
  })

  app.post("/identity/connections/:id/oidc/keys", requireFreshAuth, async (c) => {
    const loaded = await load(c)
    if ("error" in loaded) return loaded.error
    const { id, oidc, connection, tenantId } = loaded
    if (connection.provider === "google")
      return c.json(
        validation("A Google Workspace connection has no key to make."),
        422,
      )
    const refusal = await trustRefusal(c, connection)
    if (refusal) return refusal
    const stored = storedOidc(connection)
    const made = await newSigningKey()
    /*
     * ⚠ THE PREVIOUS KEY STAYS PUBLISHED, AND ONLY THE PREVIOUS ONE. An IdP that
     * caches our JWKS keeps accepting assertions until it refetches; we sign
     * with the new key at once. A second rotation retires the oldest.
     */
    const after = await id.store.setConnectionSecrets(
      tenantId,
      connection.id,
      (now) => {
        const sealed = sealedOidc(now.secrets)
        const current = storedOidc({ config: now.config })
        return {
          secrets: {
            ...now.secrets,
            oidc: {
              ...sealed,
              privateKeys: [made.privateKey, ...(sealed.privateKeys ?? [])].slice(0, 2),
            },
          },
          config: {
            ...now.config,
            oidc: {
              ...current,
              keys: [made.publicKey, ...(current.keys ?? [])].slice(0, 2),
            },
          },
        }
      },
    )
    if (!after) return c.json(notFound(), 404)
    const { userId } = c.get("user")
    await id.store.record(tenantId, {
      type: "connection.key_rotated",
      actorUserId: userId,
      connectionId: connection.id,
      data: {
        kid: made.publicKey.kid,
        previous: stored.keys?.[0]?.kid ?? null,
        status: connection.status,
      },
    })
    return c.json(oidcSetupView(after, oidc), 201)
  })
}

/**
 * Who changes a connection's IdP settings, for the audit log: a console user,
 * or a setup link acting for the customer's IT contact (#340), which has no
 * user and is named by its id.
 */
export interface SettingsActor {
  userId: string | null
  setupLinkId?: string
}

/** The connection a settings write is for, already loaded and allowed. */
export interface OidcTarget {
  id: NonNullable<ConsoleDeps["identity"]>
  oidc: OidcConsoleDeps
  connection: Connection
  tenantId: string
}

const actorData = (actor: SettingsActor) =>
  actor.setupLinkId ? { setupLinkId: actor.setupLinkId } : {}

/**
 * `PUT .../oidc`: the body merged over what is stored, the trust rule, the
 * issuer proved through the egress guard, saved and audited. Shared by the
 * console and setup links (routes/sso-setup.ts); `trustRefusal` is the
 * caller's answer to "may this actor change who the connection trusts".
 */
export async function putOidcSettings(
  c: Context,
  t: OidcTarget,
  body: Record<string, unknown>,
  actor: SettingsActor,
  trustRefusal: () => Promise<Response | null>,
): Promise<Response> {
  const { id, oidc, connection, tenantId } = t
  const preset = presetOf(connection.provider)
  if (!preset)
    return c.json(validation("This connection's provider is not known."), 422)
  const read = readOidcInput(body, preset, storedOidc(connection))
  if (typeof read === "string") return c.json(validation(read), 422)
  const trust = read.changed.filter((k) =>
    (TRUST_FIELDS as readonly string[]).includes(k),
  )
  if (trust.length) {
    const refusal = await trustRefusal()
    if (refusal) return refusal
  }
  /*
   * ⚠ THE ISSUER IS PROVED BEFORE IT IS SAVED: its discovery document is
   * fetched through the egress guard and must name exactly this issuer. A
   * private address, an unreachable host or a mismatched document is a 422
   * here, not a broken sign-in later.
   */
  if (
    read.next.issuer &&
    (trust.includes("issuer") || trust.includes("discoveryUrl"))
  ) {
    try {
      await oidc.engine.discover({
        issuer: read.next.issuer,
        discoveryUrl: read.next.discoveryUrl ?? null,
      })
    } catch (error) {
      /*
       * ⚠ A GENERIC ANSWER, THE REASON IN OUR LOG ONLY. The guard's reason
       * names what a host resolved to; echoed here it would let a workspace
       * admin map names inside our network one 422 at a time. Problems with
       * the IdP's own document are the admin's to fix, so those are said.
       */
      if (error instanceof OidcMisconfigured)
        return c.json(validation(`We could not use that issuer: ${error.message}`), 422)
      id.log.warn(
        {
          connectionId: connection.id,
          err: error instanceof Error ? error.message : "unknown",
        },
        "an OIDC issuer could not be reached through the egress guard",
      )
      return c.json(
        validation(
          "We could not reach that issuer's discovery document from the internet. Check the URL and that it is public.",
        ),
        422,
      )
    }
  }
  const after = await id.store.updateConnection(tenantId, connection.id, {
    config: { ...connection.config, oidc: read.next },
  })
  if (!after) return c.json(notFound(), 404)
  if (read.changed.length)
    await id.store.record(tenantId, {
      type: "connection.oidc_updated",
      actorUserId: actor.userId,
      connectionId: connection.id,
      data: {
        changed: read.changed,
        trust: trust.length > 0,
        status: connection.status,
        from: pickFields(storedOidc(connection), read.changed),
        to: pickFields(read.next, read.changed),
        ...actorData(actor),
      },
    })
  return c.json(oidcSetupView(after, oidc))
}

/** `PUT .../oidc/secret`: set or rotate the client secret, write-only. */
export async function putOidcSecret(
  c: Context,
  t: OidcTarget,
  body: Record<string, unknown>,
  actor: SettingsActor,
  trustRefusal: () => Promise<Response | null>,
): Promise<Response> {
  const { id, oidc, connection, tenantId } = t
  if (connection.provider === "google")
    return c.json(
      validation("A Google Workspace connection has no secret to set."),
      422,
    )
  const refusal = await trustRefusal()
  if (refusal) return refusal
  const secret = body.clientSecret
  if (
    typeof secret !== "string" ||
    !/^[\x20-\x7E]{1,1024}$/.test(secret) ||
    !secret.trim()
  )
    return c.json(validation("clientSecret must be 1 to 1024 visible characters."), 422)
  const stored = storedOidc(connection)
  const after = await id.store.setConnectionSecrets(tenantId, connection.id, (now) => ({
    secrets: {
      ...now.secrets,
      oidc: { ...sealedOidc(now.secrets), clientSecret: secret },
    },
    config: {
      ...now.config,
      oidc: { ...storedOidc({ config: now.config }), clientSecretSet: true },
    },
  }))
  if (!after) return c.json(notFound(), 404)
  await id.store.record(tenantId, {
    type: "connection.secret_set",
    actorUserId: actor.userId,
    connectionId: connection.id,
    // ⚠ THAT IT CHANGED, NEVER WHAT TO.
    data: {
      kind: "client_secret",
      rotated: stored.clientSecretSet === true,
      status: connection.status,
      ...actorData(actor),
    },
  })
  return c.json(oidcSetupView(after, oidc))
}

function pickFields(o: StoredOidc, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((k) => [k, (o as Record<string, unknown>)[k] ?? null]),
  )
}
