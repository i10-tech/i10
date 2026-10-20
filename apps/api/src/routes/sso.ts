import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  bind,
  completeLogin,
  redeemHandoff,
  startLogin,
  type BridgeDeps,
} from "../identity/bridge.js"
import {
  readSecret,
  refusalMessage,
  safeReturnTo,
  type AttemptPurpose,
  type Refusal,
} from "../identity/model.js"
import type { SsoGateChecker } from "../identity/gate.js"
import { testAssertion } from "../identity/test-engine.js"
import type { IdentityReader } from "./devices.js"
import { equalSecrets } from "../webhooks/signing.js"

/**
 * The SSO bridge's HTTP surface (#337). Called by apps/auth's server routes,
 * which hold the browser-binding cookie; see apps/auth/app/sso.
 *
 *   POST /sso/attempts      start: { connection, purpose, binding, returnTo }
 *   POST /sso/test/assert   the TEST engine's "IdP" (dev only, 404 otherwise)
 *   POST /sso/handoff       { code, binding } -> { ticket, handoff }
 *   POST /sso/bind          Bearer <new session>, { handoff } -> bound
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
  /** May this person manage this workspace's SSO (test runs)? */
  mayManage(tenantId: string, userId: string): Promise<boolean>
  /** The connection's tenant, for the `test_run` permission check. */
  tenantOfConnection(connectionId: string): Promise<string | null>
}

export interface InternalIdentityDeps {
  /** `IDENTITY_GATEWAY_SECRET`. Absent: every call is 503. */
  secret: string | undefined
  managedByIdentifier(identifier: string): Promise<boolean>
  managedBySession(sessionId: string): Promise<boolean>
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void }
}

const small = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json({ statusCode: 413, name: "validation_error", message: "Too large." }, 413),
})

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

const invalid = (c: Context, message: string) =>
  c.json({ statusCode: 422, name: "validation_error", message }, 422)

const refused = (c: Context, reason: Refusal | string) =>
  c.json(
    {
      statusCode: 409,
      name: "sso_refused",
      reason,
      message: refusalMessage(reason as Refusal),
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
  app.use("*", small)
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

  app.post("/attempts", async (c) => {
    const d = deps!
    const b = await body(c)
    const binding = readSecret(b.binding)
    const connection = typeof b.connection === "string" ? b.connection : null
    const purpose = PURPOSES.find((p) => p === b.purpose) ?? "sign_in"
    if (!binding || !connection)
      return invalid(c, "connection and binding are required.")
    const returnTo = safeReturnTo(b.returnTo, d.returnOrigins)

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
        ...(stepUp ? { stepUp } : {}),
      })
      if (started.outcome === "refused") return refused(c, started.reason)
      return c.json({ redirectUrl: started.redirectUrl }, 200)
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
      if (done.outcome === "refused") return refused(c, done.reason)
      return c.json(done, 200)
    } catch (error) {
      d.bridge.log.error(
        { err: String(error) },
        "could not complete a test SSO sign-in",
      )
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
