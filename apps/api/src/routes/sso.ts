import { Hono, type Context, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  bind,
  completeLogin,
  redeemHandoff,
  startLogin,
  type BridgeDeps,
} from "../identity/bridge.js"
import {
  emailDomain,
  normaliseEmail,
  readLoginHint,
  readSecret,
  refusalMessage,
  safeReturnTo,
  type AttemptPurpose,
  type Refusal,
} from "../identity/model.js"
import { strictestFirst } from "../identity/enforcement.js"
import type { SsoPolicyStore } from "../identity/ports.js"
import { createSetupRoutes, type SetupRouteDeps } from "./sso-setup.js"
import type { SsoGateChecker } from "../identity/gate.js"
import { testAssertion } from "../identity/test-engine.js"
import {
  finishOidc,
  publicJwks,
  readCallbackQuery,
  type OidcEngine,
} from "../identity/oidc.js"
import {
  finishSaml,
  finishSlo,
  startLogout,
  type SamlEngine,
  type SloDeps,
} from "../identity/saml.js"
import type { BackchannelOutcome } from "../identity/oidc-logout.js"
import type { IdentityReader } from "./devices.js"
import { equalSecrets } from "../webhooks/signing.js"
import { z } from "zod"

/**
 * The SSO bridge's HTTP surface (#337). Called by apps/auth's server routes,
 * which hold the browser-binding cookie; see apps/auth/app/sso.
 *
 *   POST /sso/attempts      start: { connection, purpose, binding, returnTo }
 *   POST /sso/test/assert   the TEST engine's "IdP" (dev only, 404 otherwise)
 *   POST /sso/oidc/callback { state, binding, query } -> as completeLogin (#338)
 *   GET  /sso/oidc/jwks/:id the public keys of a private_key_jwt connection
 *   POST /sso/oidc/backchannel/:id  an IdP's form-encoded `logout_token` (#345)
 *   POST /sso/saml/acs      { connection, samlResponse, relayState, binding, freshBinding } (#339)
 *   GET  /sso/saml/metadata/:id   our SP metadata for a SAML connection
 *   POST /sso/saml/slo      an IdP's LogoutRequest or LogoutResponse, either binding
 *   POST /sso/saml/logout   Bearer <session> -> SP-initiated logout's redirect
 *   POST /sso/handoff       { code, binding } -> { ticket, handoff }
 *   POST /sso/bind          Bearer <new session>, { handoff } -> bound
 *   POST /sso/discover      { email } -> which SSO, if any, the address uses (#340)
 *   ...  /sso/setup/:token  a setup link's routes (#340, sso-setup.ts)
 *
 * ⚠ PUBLIC ROUTES, AND SAFE AS PUBLIC ROUTES. Each step needs a secret only
 * the browser that started holds (the binding value, which apps/auth keeps in
 * an httpOnly cookie) plus one only the previous step handed out (state, code,
 * handoff). Called directly by anyone else, every one of them is refused.
 *
 * ⚠ NEVER A COOKIE HERE: everything arrives in the body or as a bearer
 * header, so no other site can make a browser call these with its
 * credentials.
 */

export interface SsoRouteDeps {
  bridge: BridgeDeps
  gate: SsoGateChecker
  /** The auth app's session, for `bind` and step-up. Origins: `AUTH_ORIGINS`. */
  identify: IdentityReader
  /** Where a finished sign-in may send the browser. */
  returnOrigins: readonly string[]
  /** Whether the TEST engine is on (identity/test-engine.ts). */
  testEngine: boolean
  /**
   * Per-IP and per-connection limits on every POST here (identity/
   * rate-limit.ts). Absent: unlimited (tests).
   */
  rateLimit?: MiddlewareHandler
  /** The OIDC engine (#338), when wired. Absent: its routes are 404. */
  oidc?: OidcEngine
  /** OIDC back-channel logout (#345). Absent: its route is 404. */
  oidcLogout?: (input: {
    connectionId: string
    logoutToken: string
  }) => Promise<BackchannelOutcome>
  /** The SAML engine and what its logout needs (#339). Absent: its routes are 404. */
  saml?: { engine: SamlEngine; slo: SloDeps }
  /** May this person manage this workspace's SSO (test runs)? */
  mayManage(tenantId: string, userId: string): Promise<boolean>
  /** The connection's tenant, for the `test_run` permission check. */
  tenantOfConnection(connectionId: string): Promise<string | null>
  /** Home realm discovery (#340). Absent: `/discover` is 404. */
  discovery?: {
    store: Pick<SsoPolicyStore, "discover">
    startUrl: (connectionId: string | null) => string | null
  }
  /** Setup links (#340). Absent: `/setup/*` is 404. */
  setup?: SetupRouteDeps
}

export interface InternalIdentityDeps {
  /** `IDENTITY_GATEWAY_SECRET`. Absent: every call is 503. */
  secret: string | undefined
  managedByIdentifier(identifier: string): Promise<boolean>
  managedBySession(sessionId: string): Promise<boolean>
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void }
}

const tooLarge = (c: Context) =>
  c.json({ statusCode: 413, name: "validation_error", message: "Too large." }, 413)
const small = bodyLimit({ maxSize: 16 * 1024, onError: tooLarge })
/**
 * ⚠ A SAML RESPONSE IS THE ONE BIG BODY: a signed, possibly encrypted
 * assertion with certificates, base64 in JSON. The verifier caps the decoded
 * XML at 256 KiB; this caps what reaches it.
 */
const SAML_BODY = 400 * 1024
const large = bodyLimit({ maxSize: SAML_BODY, onError: tooLarge })
const SAML_LARGE = new Set(["/saml/acs", "/saml/slo"])
/** A setup link's SAML settings may carry the IdP's metadata file (256 KiB). */
const SETUP_SAML = /^\/setup\/[A-Za-z0-9_-]+\/saml$/
const DiscoverBody = z.object({ email: z.string().max(320) }).strict()

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const SECRET = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
const AcsBody = z.object({
  connection: UUID,
  samlResponse: z.string().min(1).max(SAML_BODY),
  relayState: z.string().max(80).nullable().optional(),
  binding: SECRET.nullable().optional(),
  freshBinding: SECRET,
})
const SloBody = z.discriminatedUnion("binding", [
  z.object({
    connection: UUID,
    binding: z.literal("redirect"),
    rawQuery: z
      .string()
      .min(1)
      .max(96 * 1024),
  }),
  z.object({
    connection: UUID,
    binding: z.literal("post"),
    parameter: z.enum(["SAMLRequest", "SAMLResponse"]),
    message: z
      .string()
      .min(1)
      .max(96 * 1024),
    relayState: z.string().max(80).nullable().optional(),
  }),
])

/** The one field of a back-channel logout request: a compact JWS, bounded. */
const LogoutBody = z.string().min(1).max(8192)

const unavailable = (c: Context) => {
  c.header("Retry-After", "5")
  return c.json(
    {
      statusCode: 503,
      name: "service_unavailable",
      message: "Sign-in is temporarily unavailable. Try again in a moment.",
    },
    503,
  )
}

const notFound = (c: Context) =>
  c.json({ statusCode: 404, name: "not_found", message: "Not found." }, 404)

const invalid = (c: Context, message: string) =>
  c.json({ statusCode: 422, name: "validation_error", message }, 422)

/** `message`: the bridge's own words for this refusal ("Acme is full right now..."). */
const refused = (c: Context, reason: Refusal | string, message?: string) =>
  c.json(
    {
      statusCode: 409,
      name: "sso_refused",
      reason,
      message: message ?? refusalMessage(reason as Refusal),
    },
    409,
  )

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json()
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const PURPOSES: readonly AttemptPurpose[] = ["sign_in", "test_run", "step_up"]

export function createSsoRoutes(deps?: SsoRouteDeps) {
  const app = new Hono()
  app.use("*", (c, next) => {
    const path = c.req.path.replace(/^.*\/sso/, "")
    return (SAML_LARGE.has(path) || SETUP_SAML.test(path) ? large : small)(c, next)
  })
  app.use("*", async (c, next) => {
    if (!deps)
      return c.json(
        {
          statusCode: 501,
          name: "internal_server_error",
          message: "SSO is not configured.",
        },
        501,
      )
    await next()
  })
  // ⚠ EVERY POST, NOT THE PUBLIC KEYS: an IdP fetching our JWKS is not a sign-in.
  app.use("*", async (c, next) => {
    if (c.req.method !== "POST" || !deps?.rateLimit) return next()
    return deps.rateLimit(c, next)
  })

  /*
   * ⚠ THE ANSWER DEPENDS ON THE ADDRESS'S DOMAIN AND NOTHING ELSE (#340): the
   * same input always gets the same answer, whoever holds the address, so it
   * never says whether an account or a membership exists. "required" is what
   * the gate's rule 1 says of an address on that connection's live domain.
   */
  app.post("/discover", async (c) => {
    const d = deps!
    if (!d.discovery) return notFound(c)
    const parsed = DiscoverBody.safeParse(await body(c))
    if (!parsed.success) return invalid(c, "email is required.")
    c.header("Cache-Control", "no-store")
    const email = normaliseEmail(parsed.data.email)
    if (!email) return c.json({ sso: "none" }, 200)
    try {
      const [pick] = strictestFirst(
        await d.discovery.store.discover(emailDomain(email)),
      )
      if (!pick) return c.json({ sso: "none" }, 200)
      return c.json(
        {
          sso:
            pick.enforcement === "required_domain" ||
            pick.enforcement === "required_all"
              ? "required"
              : "available",
          connection: pick.id,
          startUrl: d.discovery.startUrl(pick.id),
          name: pick.name,
        },
        200,
      )
    } catch (error) {
      d.bridge.log.error(
        { err: error instanceof Error ? error.name : "unknown" },
        "could not discover an address's SSO",
      )
      return unavailable(c)
    }
  })

  if (deps?.setup) app.route("/setup", createSetupRoutes(deps.setup))

  app.post("/attempts", async (c) => {
    const d = deps!
    const b = await body(c)
    const binding = readSecret(b.binding)
    const connection = typeof b.connection === "string" ? b.connection : null
    const purpose = PURPOSES.find((p) => p === b.purpose) ?? "sign_in"
    if (!binding || !connection)
      return invalid(c, "connection and binding are required.")
    const returnTo = safeReturnTo(b.returnTo, d.returnOrigins)
    // ⚠ A step-up re-asks the same IdP session, so it never takes a hint.
    const loginHint = purpose === "step_up" ? null : readLoginHint(b.loginHint)
    // "Sign in as" after the IdP answered for somebody else (sso-continue.tsx).
    const forceLogin = purpose === "sign_in" && b.fresh === true

    try {
      let stepUp: { userId: string; sessionId: string } | undefined
      if (purpose === "step_up" || purpose === "test_run") {
        const who = await d.identify(c.req.raw)
        if (who.status === "unavailable") return unavailable(c)
        if (who.status === "signed-out")
          return c.json(
            { statusCode: 401, name: "invalid_access", message: "Sign in first." },
            401,
          )
        if (purpose === "step_up")
          stepUp = { userId: who.userId, sessionId: who.sessionId }
        else {
          // ⚠ A TEST RUN IS AN ADMIN'S, so its claims land on their setup screen.
          const tenantId = await d.tenantOfConnection(connection)
          if (!tenantId || !(await d.mayManage(tenantId, who.userId)))
            return c.json(
              {
                statusCode: 403,
                name: "forbidden",
                message: "You cannot test this connection.",
              },
              403,
            )
        }
      }
      const started = await startLogin(d.bridge, {
        connectionId: connection,
        purpose,
        binding,
        returnTo,
        loginHint,
        forceLogin,
        ...(stepUp ? { stepUp } : {}),
      })
      if (started.outcome === "refused") return refused(c, started.reason)
      return c.json(
        { redirectUrl: started.redirectUrl, protocol: started.protocol },
        200,
      )
    } catch (error) {
      d.bridge.log.error({ err: String(error) }, "could not start an SSO sign-in")
      return unavailable(c)
    }
  })

  app.post("/test/assert", async (c) => {
    const d = deps!
    // ⚠ 404, NOT 403, WHEN OFF: the route does not exist outside development.
    if (!d.testEngine)
      return c.json({ statusCode: 404, name: "not_found", message: "Not found." }, 404)
    const b = await body(c)
    const binding = readSecret(b.binding)
    const state = readSecret(b.state)
    const assertion = testAssertion(b)
    if (!binding || !state || !assertion)
      return invalid(c, "state, binding, subject and email are required.")
    try {
      const done = await completeLogin(d.bridge, {
        state,
        binding,
        assertion,
        protocol: "test",
      })
      if (done.outcome === "refused") return refused(c, done.reason, done.message)
      return c.json(done, 200)
    } catch (error) {
      d.bridge.log.error(
        { err: String(error) },
        "could not complete a test SSO sign-in",
      )
      return unavailable(c)
    }
  })

  app.post("/oidc/callback", async (c) => {
    const d = deps!
    if (!d.oidc)
      return c.json({ statusCode: 404, name: "not_found", message: "Not found." }, 404)
    const b = await body(c)
    const binding = readSecret(b.binding)
    const state = readSecret(b.state)
    const query = readCallbackQuery(b.query)
    if (!binding || !state || !query)
      return invalid(c, "state, binding and the callback's code or error are required.")
    try {
      const via = b.via === "google" ? "google" : "oidc"
      const done = await finishOidc(d.bridge, d.oidc, { state, binding, query, via })
      if (done.outcome === "unavailable") return unavailable(c)
      if (done.outcome === "refused") return refused(c, done.reason, done.message)
      return c.json(done, 200)
    } catch (error) {
      // ⚠ THE ERROR'S NAME AND MESSAGE ONLY, never its cause: openid-client
      // keeps the callback's parameters, code included, on its errors.
      d.bridge.log.error(
        { err: error instanceof Error ? `${error.name}: ${error.message}` : "unknown" },
        "could not complete an OIDC sign-in",
      )
      return unavailable(c)
    }
  })

  /*
   * ⚠ PUBLIC KEYS ONLY, AND ONLY OIDC CONNECTIONS. The IdP fetches this to
   * check our private_key_jwt assertions; it says nothing a connection id does
   * not already name, and a draft needs it as much as an active one (the IdP
   * is set up first).
   */
  app.get("/oidc/jwks/:connection", async (c) => {
    const d = deps!
    const id = c.req.param("connection")
    const notFound = () =>
      c.json({ statusCode: 404, name: "not_found", message: "Not found." }, 404)
    if (!d.oidc) return notFound()
    try {
      const connection = await d.bridge.store.connectionForStart(id)
      if (!connection || connection.protocol !== "oidc") return notFound()
      c.header("Cache-Control", "public, max-age=300")
      return c.json(publicJwks(connection), 200)
    } catch (error) {
      d.bridge.log.error({ err: String(error) }, "could not read a connection's JWKS")
      return unavailable(c)
    }
  })

  /*
   * ⚠ AN IdP'S SERVER CALLS THIS, NOT A BROWSER (#345): form-encoded, with the
   * signed `logout_token` and nothing else, and no cookie, session or header
   * of ours. Everything it proves is in the token. The answer is 200 when the
   * token was accepted, 400 with no detail when it was not (so a caller learns
   * nothing about which check failed), 503 when we could not tell.
   */
  app.post("/oidc/backchannel/:connection", async (c) => {
    const d = deps!
    if (!d.oidcLogout) return notFound(c)
    // Spec 2.8: a response to a logout request must never be cached.
    c.header("Cache-Control", "no-store")
    const rejected = () => c.json({ error: "invalid_request" }, 400)
    const connectionId = UUID.safeParse(c.req.param("connection"))
    if (!connectionId.success) return rejected()
    if (
      !(c.req.header("content-type") ?? "")
        .toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    )
      return rejected()
    const fields = new URLSearchParams(await c.req.text().catch(() => ""))
    const tokens = fields.getAll("logout_token")
    const parsed = LogoutBody.safeParse(tokens.length === 1 ? tokens[0] : null)
    if (!parsed.success) return rejected()
    try {
      const done = await d.oidcLogout({
        connectionId: connectionId.data.toLowerCase(),
        logoutToken: parsed.data,
      })
      if (done.outcome === "unavailable") return unavailable(c)
      if (done.outcome === "refused") return rejected()
      return c.body(null, 200)
    } catch (error) {
      d.bridge.log.error(
        { err: error instanceof Error ? error.name : "unknown" },
        "could not handle an OIDC back-channel logout",
      )
      return unavailable(c)
    }
  })

  app.post("/saml/acs", async (c) => {
    const d = deps!
    if (!d.saml) return notFound(c)
    const parsed = AcsBody.safeParse(await body(c))
    if (!parsed.success)
      return invalid(c, "connection, samlResponse and freshBinding are required.")
    const b = parsed.data
    try {
      const done = await finishSaml(d.bridge, d.saml.engine, {
        connectionId: b.connection.toLowerCase(),
        samlResponse: b.samlResponse,
        relayState: b.relayState ?? null,
        binding: b.binding ?? null,
        freshBinding: b.freshBinding,
      })
      if (done.outcome === "unavailable") return unavailable(c)
      if (done.outcome === "refused") return refused(c, done.reason, done.message)
      return c.json(done, 200)
    } catch (error) {
      // ⚠ THE NAME AND MESSAGE ONLY: never the response, which is an assertion.
      d.bridge.log.error(
        { err: error instanceof Error ? `${error.name}: ${error.message}` : "unknown" },
        "could not complete a SAML sign-in",
      )
      return unavailable(c)
    }
  })

  /*
   * ⚠ PUBLIC, LIKE THE OIDC JWKS: an IdP's admin (or its metadata fetcher)
   * reads it before the connection is live. Only public certificates.
   */
  app.get("/saml/metadata/:connection", async (c) => {
    const d = deps!
    if (!d.saml) return notFound(c)
    const id = c.req.param("connection")
    if (!UUID.safeParse(id).success) return notFound(c)
    try {
      const connection = await d.bridge.store.connectionForStart(id)
      if (!connection || connection.protocol !== "saml") return notFound(c)
      c.header("Content-Type", "application/samlmetadata+xml; charset=utf-8")
      c.header("Cache-Control", "public, max-age=300")
      return c.body(d.saml.engine.metadata(connection), 200)
    } catch (error) {
      d.bridge.log.error(
        { err: String(error) },
        "could not read a connection's SAML metadata",
      )
      return unavailable(c)
    }
  })

  app.post("/saml/slo", async (c) => {
    const d = deps!
    if (!d.saml) return notFound(c)
    const parsed = SloBody.safeParse(await body(c))
    if (!parsed.success) return invalid(c, "A SAML logout message is required.")
    const b = parsed.data
    try {
      const done = await finishSlo(
        d.saml.slo,
        d.saml.engine,
        b.binding === "redirect"
          ? {
              connectionId: b.connection.toLowerCase(),
              binding: "redirect",
              rawQuery: b.rawQuery,
            }
          : {
              connectionId: b.connection.toLowerCase(),
              binding: "post",
              parameter: b.parameter,
              message: b.message,
              relayState: b.relayState ?? null,
            },
      )
      if (done.outcome === "unavailable") return unavailable(c)
      if (done.outcome === "refused")
        return c.json(
          {
            statusCode: 409,
            name: "sso_refused",
            reason: "logout_refused",
            message: "That logout was not accepted.",
          },
          409,
        )
      return c.json(done, 200)
    } catch (error) {
      d.bridge.log.error(
        { err: error instanceof Error ? `${error.name}: ${error.message}` : "unknown" },
        "could not handle a SAML logout",
      )
      return unavailable(c)
    }
  })

  app.post("/saml/logout", async (c) => {
    const d = deps!
    if (!d.saml) return notFound(c)
    try {
      const who = await d.identify(c.req.raw)
      if (who.status === "unavailable") return unavailable(c)
      if (who.status === "signed-out")
        return c.json(
          { statusCode: 401, name: "invalid_access", message: "Not signed in." },
          401,
        )
      const managed = await d.bridge.store.managedByUser(who.userId)
      if (!managed) return c.json({ redirectUrl: null }, 200)
      const done = await startLogout(d.saml.slo, d.saml.engine, {
        tenantId: managed.tenantId,
        userId: who.userId,
        sessionId: who.sessionId,
      })
      return c.json(
        { redirectUrl: done.outcome === "redirect" ? done.redirectUrl : null },
        200,
      )
    } catch (error) {
      d.bridge.log.error({ err: String(error) }, "could not start a SAML logout")
      return unavailable(c)
    }
  })

  app.post("/handoff", async (c) => {
    const d = deps!
    const b = await body(c)
    const code = readSecret(b.code)
    const binding = readSecret(b.binding)
    if (!code || !binding) return invalid(c, "code and binding are required.")
    try {
      const redeemed = await redeemHandoff(d.bridge, { code, binding })
      if (redeemed.outcome === "refused") return refused(c, redeemed.reason)
      return c.json({ ticket: redeemed.ticket, handoff: redeemed.handoff }, 200)
    } catch (error) {
      d.bridge.log.error({ err: String(error) }, "could not redeem an SSO handoff")
      return unavailable(c)
    }
  })

  app.post("/bind", async (c) => {
    const d = deps!
    const b = await body(c)
    const handoff = readSecret(b.handoff)
    if (!handoff) return invalid(c, "handoff is required.")
    try {
      const who = await d.identify(c.req.raw)
      if (who.status === "unavailable") return unavailable(c)
      if (who.status === "signed-out")
        return c.json(
          { statusCode: 401, name: "invalid_access", message: "Not signed in." },
          401,
        )
      const bound = await bind(d.bridge, {
        userId: who.userId,
        sessionId: who.sessionId,
        handoff,
      })
      if (bound.outcome === "refused") return refused(c, bound.reason)
      d.gate.forget({ userId: who.userId, sessionId: who.sessionId })
      return c.json({ returnTo: bound.returnTo }, 200)
    } catch (error) {
      d.bridge.log.error({ err: String(error) }, "could not bind an SSO session")
      return unavailable(c)
    }
  })

  return app
}

/**
 * What the Clerk gateway asks (#336's `ManagedAccounts`), behind a shared
 * secret.
 *
 *   POST /internal/identity/managed  { identifier } | { sessionId } -> { managed }
 *
 * ⚠ EVERY FAILURE IS A 503, NEVER `managed: false`. The gateway turns a 503
 * into its own 503; an answer of "no" on an outage would wave a managed
 * account past its company's SSO exactly when we cannot check.
 */
export function createInternalIdentityRoutes(deps?: InternalIdentityDeps) {
  const app = new Hono()
  app.use("*", small)

  app.post("/managed", async (c) => {
    if (!deps?.secret) return unavailable(c)
    const header = c.req.header("Authorization") ?? ""
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!equalSecrets(deps.secret, given))
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Bad token." },
        401,
      )

    const b = await body(c)
    try {
      if (typeof b.identifier === "string" && b.identifier.length <= 320) {
        const identifier = b.identifier.trim().toLowerCase()
        return c.json({
          managed: identifier ? await deps.managedByIdentifier(identifier) : false,
        })
      }
      if (
        typeof b.sessionId === "string" &&
        /^sess_[A-Za-z0-9]{1,64}$/.test(b.sessionId)
      )
        return c.json({ managed: await deps.managedBySession(b.sessionId) })
      return invalid(c, "identifier or sessionId is required.")
    } catch (error) {
      deps.log.error(
        { err: String(error) },
        "could not answer the gateway's managed lookup",
      )
      return unavailable(c)
    }
  })

  return app
}
