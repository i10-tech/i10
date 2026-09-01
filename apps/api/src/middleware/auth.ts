import type { MiddlewareHandler } from "hono"
import { verifyApiKey, type Mode, type VerifyDeps } from "../auth/api-key.js"

export interface AuthContext {
  apiKeyId: string
  /**
   * i10's own tenant id, taken from Clerk's claims on the key.
   *
   * NOT Clerk's `subject`, which is a `user_…` or `org_…`. A tenant may
   * reference either, or neither — see core.tenants.
   */
  tenantId: string
  scopes: readonly string[]
  mode: Mode
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext
    /**
     * Injected once by createApp rather than closed over by the route module,
     * because the routes are declared at import time and `middleware:` on a
     * createRoute() is resolved then.
     */
    apiKeyAuth?: VerifyDeps
  }
}

/**
 * Bearer-token authentication.
 *
 * ⚠ THE HEADER IS NOT OURS TO CHANGE. `Authorization: Bearer` is what makes
 * `resend/node` → `@i10/node` a one-line migration. The key FORMAT is ours —
 * `i10_live_…` is recognisable in a customer's logs and greppable in a leak
 * scan — but a custom header would break the pitch outright.
 *
 * ⚠ AUTHENTICATION IS NOT QUOTA. This answers "is this key valid and what may
 * it do". Whether the customer has sending budget left is a different question
 * with a different failure mode and a different owner (Autumn). Collapsing the
 * two makes it impossible to sell a plan that differs only by volume, and it
 * makes `rate_limit_exceeded` (retryable) indistinguishable from
 * `daily_quota_exceeded` (not).
 *
 * Two typing notes, both found by the compiler rather than guessed:
 *
 * Errors go through `c.json`, not a bare `Response`. Under @types/node the
 * global Response resolves to undici's, and a middleware whose inferred type
 * reaches into `undici-types` fails to compile the moment anyone names it
 * (TS2883).
 *
 * And it is annotated as `MiddlewareHandler` rather than built with
 * `createMiddleware`, because that helper infers the return type from the
 * handler — so returning a 401 in one branch and a 503 in another produces two
 * incompatible `JSONRespondReturn` types and the whole thing stops assigning.
 */
export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    return c.json(
      {
        statusCode: 401,
        name: "invalid_access",
        message: "Missing API key. Send `Authorization: Bearer <key>`.",
      },
      401,
    )
  }

  const deps = c.get("apiKeyAuth")
  if (!deps) {
    // No verifier configured. Refusing is the only safe answer: falling through
    // would let an unauthenticated caller reach the send path.
    return c.json(
      {
        statusCode: 501,
        name: "internal_server_error",
        message: "API key verification is not wired up yet.",
      },
      501,
    )
  }

  const outcome = await verifyApiKey(header.slice("Bearer ".length).trim(), deps)

  switch (outcome.status) {
    case "verified":
      c.set("auth", outcome.key)
      await next()
      return

    case "rejected":
      return c.json(
        {
          statusCode: 401,
          name: "invalid_access",
          message: "Invalid API key.",
        },
        401,
      )

    default:
      // ⚠ 503, NEVER 401. Clerk did not answer, so we do not know whether the
      // key is good — and a 401 tells the customer their key is wrong. They
      // respond by rotating a key that was fine, during an outage that was
      // never theirs. Same rule as services/authd answering LDAP `unavailable`
      // rather than `invalidCredentials`. `Retry-After` is what makes an SDK
      // back off instead of hammering.
      c.header("Retry-After", "5")
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Could not verify the API key right now. Retry shortly.",
        },
        503,
      )
  }
}
