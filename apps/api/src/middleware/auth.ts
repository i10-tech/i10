import type { MiddlewareHandler } from "hono"

export interface AuthContext {
  apiKeyId: string
  accountId: string
  scopes: readonly string[]
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext
  }
}

/** Matches `i10_live_…` and `i10_test_…`. */
const KEY_PATTERN = /^i10_(live|test)_[A-Za-z0-9]{24,}$/

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
 * handler — so returning a 401 in one branch and a 501 in another produces two
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

  const key = header.slice("Bearer ".length).trim()
  if (!KEY_PATTERN.test(key)) {
    return c.json(
      {
        statusCode: 401,
        name: "invalid_access",
        message: "Malformed API key.",
      },
      401,
    )
  }

  // TODO(phase-2): resolve the key through Clerk's API keys feature —
  // long-lived, opaque, owned by a user or organization, carrying scope
  // strings, with the secret returned once at creation and never retrievable.
  //
  // Verify by HASH, never by comparing plaintext, and never log the key. Then
  // set the resolved identity and fall through:
  //
  //   c.set("auth", { apiKeyId, accountId, scopes })
  //   await next()
  //
  // Until then a well-formed key is still refused, so that nothing can
  // accidentally send while the send path is unbuilt.
  void next
  return c.json(
    {
      statusCode: 501,
      name: "internal_server_error",
      message: "API key verification is not wired up yet.",
    },
    501,
  )
}
