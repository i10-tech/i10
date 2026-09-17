import type { MiddlewareHandler } from "hono"
import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { ActiveOrgReader, SessionVerifier } from "./session.js"

/**
 * The console's credential: a signed-in person, resolved to the tenant whose
 * mail they are looking at.
 *
 * ⚠ A THIRD MIDDLEWARE RATHER THAN A BRANCH INSIDE ONE OF THE OTHER TWO, AND
 * THE SEPARATION IS THE SECURITY PROPERTY. `requireApiKey` authenticates a
 * machine; `requireUser` authenticates a human and stops there, because
 * `/mailboxes` is about the person rather than the account. This one does both
 * halves — verifies the human, then answers "whose account is this" — and it is
 * the ONLY thing that lets a browser session reach tenant-scoped data. Folding
 * it into `requireApiKey` as a fallback would mean one refactor away from a
 * cookie being able to send mail, and folding it into `requireUser` would give
 * `/mailboxes` a tenant it has no use for.
 *
 * ⚠ IT SETS THE SAME `auth` CONTEXT AN API KEY DOES, ON PURPOSE. Every store in
 * this application reads `c.get("auth").tenantId`, and a console route should
 * be the same query as an API route against the same store. What it does NOT
 * do is claim to be a key: `apiKeyId` is null and `mode` is `live`, so anything
 * that logs or audits by key id records the absence rather than inventing one.
 */

export interface TenantResolver {
  /**
   * Translates a verified Clerk principal into i10's tenant id.
   *
   * Returns null when the person has no tenant yet — a sign-up whose
   * `organization.created` webhook has not landed, or an organization created
   * in Clerk's dashboard that we have not seen. The console's answer to that is
   * a 409 and a retry, not a 403: nothing is forbidden, the row is just late.
   */
  resolve(principal: { userId: string; orgId?: string | null }): Promise<string | null>
}

export function tenantResolver(db: Database): TenantResolver {
  return {
    async resolve({ userId, orgId }) {
      /*
       * ⚠ NOT INSIDE `withTenant`, WHICH WOULD BE CIRCULAR. The whole point of
       * this call is to find the value `withTenant` needs. The function is a
       * SECURITY DEFINER for exactly that reason — see 0038 — and it takes the
       * principal as arguments rather than reading a session, so it cannot be
       * asked anything broader than "translate this verified identity".
       */
      const rows = (await db.execute(sql`
        select core.tenant_for_principal(${userId}, ${orgId ?? null}) as id
      `)) as unknown as { id: string | null }[]

      return rows[0]?.id ?? null
    },
  }
}

export interface TenantAuthDeps {
  sessions: SessionVerifier
  tenants: TenantResolver
  /**
   * Reads the active organization out of a verified session.
   *
   * ⚠ SEPARATE FROM `sessions` BECAUSE `SessionVerifier` DELIBERATELY RETURNS
   * ONLY A USER ID. That interface was built for `/mailboxes`, where the
   * organization is irrelevant and returning it would be an invitation to
   * authorise against it. Widening it would change what every existing caller
   * can see; a second, optional reader changes nothing for them.
   *
   * ⚠ ITS ABSENCE IS SAFE, ITS FAILURE IS NOT. Omitting it entirely is a
   * DEPLOYMENT decision: every session then resolves through the personal
   * branch of `tenant_for_principal`, which is correct for a solo developer and
   * simply cannot see team accounts. A configured reader that FAILS is a
   * different thing — the operator said organizations exist, so a null would be
   * a guess about which workspace the caller is in. That is why it reports
   * `unknown` rather than null, and why `requireTenant` turns that into a 503.
   */
  activeOrg?: ActiveOrgReader
}

declare module "hono" {
  interface ContextVariableMap {
    /** Verifies a session and resolves it to a tenant. See `requireTenant`. */
    tenantAuth?: TenantAuthDeps
  }
}

export const requireTenant: MiddlewareHandler = async (c, next) => {
  const deps = c.get("tenantAuth")
  if (!deps) {
    return c.json(
      {
        statusCode: 501,
        name: "internal_server_error",
        message: "The console API is not wired up yet.",
      },
      501,
    )
  }

  /*
   * ⚠ THE BEARER HEADER IS REQUIRED, AND THIS IS THE CSRF DEFENCE FOR THE WHOLE
   * SURFACE. `clerk.authenticateRequest` accepts a session from the
   * `Authorization` header OR from Clerk's `__session` COOKIE, and this API has
   * no CORS policy, no Origin check and no custom-header requirement. Without
   * this line, a page on any other site could issue
   * `fetch(…, { credentials: "include" })` against `/console/*` — a simple
   * request, so no preflight — and although the attacker could not READ the
   * response, the side effect would land: contacts deleted, a key rotated, a
   * domain removed, a plan changed.
   *
   * ⚠ IT COSTS NOTHING, BECAUSE THE ONLY CLIENT ALREADY SENDS IT. The console
   * calls this surface server-side with an explicit `Authorization: Bearer
   * <session jwt>` — see apps/console/lib/api.ts. A browser cannot attach that
   * header cross-origin without a preflight the API would answer with no CORS
   * headers, so requiring it makes cookie-borne CSRF structurally impossible
   * rather than dependent on Clerk's cookie-domain configuration.
   *
   * ⚠ AND IT IS A 401, NOT A 403. A request with no credential at all is
   * unauthenticated, which is what this says.
   */
  const authorization = c.req.header("Authorization")
  if (!authorization?.startsWith("Bearer ")) {
    return c.json(
      {
        statusCode: 401,
        name: "invalid_access",
        message:
          "Send your session as `Authorization: Bearer <token>`. A cookie alone " +
          "is not accepted here.",
      },
      401,
    )
  }

  const outcome = await deps.sessions.verify(c.req.raw)

  if (outcome.status === "signed-out") {
    return c.json(
      { statusCode: 401, name: "invalid_access", message: "Sign in to continue." },
      401,
    )
  }

  if (outcome.status === "unavailable") {
    // ⚠ 503, NEVER 401 — the rule `requireApiKey` and `requireUser` both
    // follow. Clerk did not answer, so we do not know whether the session is
    // good, and telling somebody their sign-in is bad during a Clerk outage
    // makes them sign out of the one session that still works.
    c.header("Retry-After", "5")
    return c.json(
      {
        statusCode: 503,
        name: "service_unavailable",
        message: "Could not verify your session right now. Retry shortly.",
      },
      503,
    )
  }

  /*
   * ⚠ A FAILED ORG LOOKUP IS A 503, NOT A FALLBACK TO THE PERSONAL TENANT.
   * `tenant_for_principal` reads a null org as "personal", so answering null
   * here would not degrade the request — it would silently perform it against a
   * DIFFERENT WORKSPACE. On a mutating route that is an API key minted into the
   * wrong tenant, a rename of the wrong workspace, a checkout billing the wrong
   * one; and none of it looks wrong on screen, because the personal tenant is a
   * real tenant with real data. Refusing for a few seconds is recoverable.
   */
  let orgId: string | null = null
  if (deps.activeOrg) {
    const active = await deps.activeOrg(c.req.raw)
    if (active.status === "unknown") {
      c.header("Retry-After", "5")
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Could not determine your workspace right now. Retry shortly.",
        },
        503,
      )
    }
    orgId = active.status === "org" ? active.orgId : null
  }

  const tenantId = await deps.tenants.resolve({ userId: outcome.userId, orgId })

  if (!tenantId) {
    /*
     * ⚠ 409, NOT 403, AND THE CONSOLE TREATS IT AS "WAIT" RATHER THAN "NO".
     * A person in this state is signed in and entitled to an account; the row
     * simply does not exist yet, because provisioning runs off a Clerk webhook
     * that Svix may still be retrying. A 403 would render as "you do not have
     * access to this workspace" on somebody's first ten seconds with the
     * product, and they would respond by signing up again.
     */
    c.header("Retry-After", "2")
    return c.json(
      {
        statusCode: 409,
        name: "tenant_not_ready",
        message: "Your workspace is still being created. This usually takes a moment.",
      },
      409,
    )
  }

  c.set("auth", {
    // ⚠ THE EMPTY STRING SAYS "NO KEY", AND IT IS NOT A PLACEHOLDER FOR ONE.
    // `AuthContext.apiKeyId` is typed as a string because every API-key route
    // has one; a console request genuinely does not, and anything attributing
    // an action to a key will record the absence rather than a fabricated id.
    apiKeyId: "",
    tenantId,
    // ⚠ NO SCOPE RESTRICTION, WHICH IS WHAT A CONSOLE SESSION MEANS. Scopes
    // narrow a machine credential below what its owner can do. The person here
    // IS the owner, authenticated by Clerk, and a scope list would be a second
    // authorisation model that Clerk's own roles already answer better.
    scopes: [],
    mode: "live",
  })
  c.set("user", { userId: outcome.userId })

  await next()
}
