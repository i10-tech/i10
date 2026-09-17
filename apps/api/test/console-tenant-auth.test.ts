import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { requireTenant, type TenantResolver } from "../src/middleware/tenant.js"
import type { ActiveOrgReader,
  SessionOutcome, SessionVerifier } from "../src/middleware/session.js"

/**
 * The gate in front of the whole console surface.
 *
 * ⚠ THIS IS THE ONE THING IN THE CHANGE THAT LETS A BROWSER COOKIE REACH
 * TENANT-SCOPED DATA, so every one of its refusals is load-bearing and each has
 * a specific reason to be the status it is rather than a neighbouring one. The
 * tests below pin the STATUS CODES, not just "it refused" — because the console
 * branches on them and answering 403 where a 409 belongs is the difference
 * between a spinner and "you do not have access to this workspace" on somebody's
 * first ten seconds with the product.
 */

/**
 * ⚠ EVERY REQUEST BELOW CARRIES A BEARER HEADER, BECAUSE `requireTenant` NOW
 * REFUSES ONE WITHOUT IT. That refusal is the CSRF defence for the whole
 * surface — Clerk would otherwise accept a `__session` cookie, and a
 * cross-origin `fetch(…, { credentials: "include" })` is a simple request with
 * no preflight. The value is never parsed here; the stub verifier decides the
 * outcome.
 */
const BEARER = { Authorization: "Bearer stub" }

const sessions = (outcome: SessionOutcome): SessionVerifier => ({
  verify: async () => outcome,
})

const resolver = (id: string | null): TenantResolver => ({
  resolve: async () => id,
})

function appWith(deps?: {
  sessions: SessionVerifier
  tenants: TenantResolver
  activeOrg?: ActiveOrgReader
}) {
  const app = new Hono()

  app.use("*", async (c, next) => {
    if (deps) c.set("tenantAuth", deps)
    await next()
  })
  app.use("*", requireTenant)

  app.get("/whoami", (c) => {
    const auth = c.get("auth")
    const user = c.get("user")
    return c.json({ tenantId: auth.tenantId, userId: user.userId, mode: auth.mode })
  })

  return app
}

describe("requireTenant", () => {
  it("passes a signed-in principal through with the tenant on the context", async () => {
    const app = appWith({
      sessions: sessions({ status: "signed-in", userId: "user_1" }),
      tenants: resolver("11111111-1111-4111-8111-111111111111"),
    })

    const response = await app.request("/whoami", { headers: BEARER })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "user_1",
      mode: "live",
    })
  })

  /**
   * ⚠ IT SETS `apiKeyId` TO THE EMPTY STRING AND `scopes` TO EMPTY, AND NEITHER
   * IS A PLACEHOLDER. A console request genuinely has no key, so anything that
   * audits by key id records the absence rather than a fabricated id; and a
   * scope list would be a second authorization model on top of the Clerk roles
   * that already answer this better.
   */
  it("does not pretend a session is an API key", async () => {
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("tenantAuth", {
        sessions: sessions({ status: "signed-in", userId: "user_1" }),
        tenants: resolver("11111111-1111-4111-8111-111111111111"),
      })
      await next()
    })
    app.use("*", requireTenant)
    app.get("/auth", (c) => c.json(c.get("auth")))

    const body = (await (await app.request("/auth", { headers: BEARER })).json()) as {
      apiKeyId: string
      scopes: string[]
    }

    expect(body.apiKeyId).toBe("")
    expect(body.scopes).toEqual([])
  })

  /**
   * ⚠ THE CSRF DEFENCE, AND IT HAS TO BE CHECKED BEFORE THE SESSION IS VERIFIED.
   * A cross-site POST carrying Clerk's `__session` cookie would otherwise
   * authenticate perfectly well and perform its side effect — a contact bulk
   * delete, a key rotation, a domain removal — even though the attacker could
   * not read the response.
   */
  it("refuses a request with no Authorization header, even with a good session", async () => {
    const app = appWith({
      sessions: sessions({ status: "signed-in", userId: "user_1" }),
      tenants: resolver("11111111-1111-4111-8111-111111111111"),
    })

    const response = await app.request("/whoami")
    expect(response.status).toBe(401)
    expect(((await response.json()) as { message: string }).message).toContain(
      "cookie alone",
    )
  })

  it("refuses a signed-out caller with 401", async () => {
    const app = appWith({
      sessions: sessions({ status: "signed-out" }),
      tenants: resolver("11111111-1111-4111-8111-111111111111"),
    })

    const response = await app.request("/whoami", { headers: BEARER })
    expect(response.status).toBe(401)
    expect(((await response.json()) as { name: string }).name).toBe("invalid_access")
  })

  /**
   * ⚠ 503 AND NEVER 401 WHEN CLERK DOES NOT ANSWER, AND THIS IS THE RULE
   * `requireApiKey` AND `requireUser` BOTH ALREADY FOLLOW. We do not know
   * whether the session is good, and telling somebody their sign-in is bad
   * during a Clerk outage makes them sign out of the one session that still
   * works — during the outage that would stop them signing back in.
   */
  it("answers 503 with Retry-After when the identity provider is unreachable", async () => {
    const app = appWith({
      sessions: sessions({ status: "unavailable" }),
      tenants: resolver("11111111-1111-4111-8111-111111111111"),
    })

    const response = await app.request("/whoami", { headers: BEARER })
    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("5")
    expect(((await response.json()) as { name: string }).name).toBe(
      "service_unavailable",
    )
  })

  /**
   * ⚠ 409, NOT 403, AND THE CONSOLE READS IT AS "WAIT" RATHER THAN "NO". A
   * person here is signed in and entitled to an account; the row simply does
   * not exist yet, because provisioning runs off a Clerk webhook Svix may still
   * be retrying. A 403 would render as "you do not have access to this
   * workspace" on somebody's first visit, and they would respond by signing up
   * a second time — which creates a second organization and a second tenant,
   * so now they genuinely do have two accounts.
   */
  it("answers 409 when the tenant row has not been provisioned yet", async () => {
    const app = appWith({
      sessions: sessions({ status: "signed-in", userId: "user_1" }),
      tenants: resolver(null),
    })

    const response = await app.request("/whoami", { headers: BEARER })
    expect(response.status).toBe(409)
    expect(response.headers.get("Retry-After")).toBe("2")
    expect(((await response.json()) as { name: string }).name).toBe("tenant_not_ready")
  })

  /**
   * ⚠ UNWIRED MEANS 501, NOT "LET THEM THROUGH". The tests and the OpenAPI
   * generator both build an app with no console dependencies; a middleware that
   * fell through when unconfigured would make every one of those an
   * unauthenticated path to tenant data.
   */
  it("refuses rather than falling through when it is not configured", async () => {
    const response = await appWith(undefined).request("/whoami")
    expect(response.status).toBe(501)
  })

  /**
   * ⚠ THE ORGANIZATION IS READ FROM THE VERIFIED SESSION AND NEVER FROM THE
   * REQUEST. This asserts the plumbing: whatever `activeOrg` returns is what
   * reaches the resolver, and a caller cannot influence it — there is no path
   * from a query string or a body into this argument.
   */
  it("passes the active organization from the session to the resolver", async () => {
    const seen: { userId: string; orgId?: string | null }[] = []

    const app = appWith({
      sessions: sessions({ status: "signed-in", userId: "user_1" }),
      tenants: {
        resolve: async (principal) => {
          seen.push(principal)
          return "22222222-2222-4222-8222-222222222222"
        },
      },
      activeOrg: async () => ({ status: "org", orgId: "org_acme" }),
    })

    await app.request("/whoami?org_id=org_attacker", { headers: BEARER })

    expect(seen).toEqual([{ userId: "user_1", orgId: "org_acme" }])
  })

  it("passes a null organization when the session has not activated one", async () => {
    const seen: { userId: string; orgId?: string | null }[] = []

    const app = appWith({
      sessions: sessions({ status: "signed-in", userId: "user_1" }),
      tenants: {
        resolve: async (principal) => {
          seen.push(principal)
          return "22222222-2222-4222-8222-222222222222"
        },
      },
    })

    await app.request("/whoami", { headers: BEARER })

    // ⚠ `null`, WHICH `tenant_for_principal` READS AS "the personal tenant".
    // Anything else here would silently change which account a solo developer
    // sees.
    expect(seen).toEqual([{ userId: "user_1", orgId: null }])
  })

  /**
   * ⚠ "WE COULD NOT TELL WHICH WORKSPACE" MUST NOT RESOLVE TO THE PERSONAL ONE.
   * `tenant_for_principal` reads a null org as "personal", so a reader that
   * collapsed its failures into null would not degrade the request — it would
   * run it against a different, real, plausible-looking workspace. On a mutating
   * route that is a key minted into the wrong tenant or a rename of the wrong
   * account, with nothing on screen to say so.
   */
  it("answers 503 rather than the personal tenant when the org is unknown", async () => {
    const seen: { userId: string; orgId?: string | null }[] = []

    const app = appWith({
      sessions: sessions({ status: "signed-in", userId: "user_1" }),
      tenants: {
        resolve: async (principal) => {
          seen.push(principal)
          return "33333333-3333-4333-8333-333333333333"
        },
      },
      activeOrg: async () => ({ status: "unknown" }),
    })

    const response = await app.request("/whoami", { headers: BEARER })

    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("5")
    // ⚠ AND THE RESOLVER IS NEVER REACHED, which is the actual property: no
    // tenant is chosen at all, rather than one chosen and then discarded.
    expect(seen).toEqual([])
  })
})
