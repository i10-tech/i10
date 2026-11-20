import { errorSchema } from "@repo/contracts"
import type { MiddlewareHandler } from "hono"
import { isRestricted } from "../auth/scope.js"

/**
 * The pieces every route module needs, defined once.
 *
 * The 422 validation hook is deliberately NOT here. Hono infers a handler's
 * `c.req.valid()` types from the route it is registered with, and a hook typed
 * concretely enough to be shared collapses that inference at every call site -
 * the deduplication would be paid for in `as never` casts on the request body,
 * which is the opposite trade.
 *
 * ⚠ `errorSchema.openapi("Error")` MUST BE CALLED IN ONE PLACE. `.openapi()`
 * registers a named component, and two modules registering the same name means
 * two definitions competing for one `$ref` - whichever is imported last wins,
 * silently, and the published document describes one of them for both. Sharing
 * the object rather than the call removes the race.
 */
export const ApiError = errorSchema.openapi("Error")

/** Shorthand for the error responses every route shares. */
export const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ApiError } },
})

/**
 * ⚠ 501 RATHER THAN A SILENT SUCCESS OR A 404. An unconfigured deployment that
 * answered 200 would tell callers their work was accepted while nothing existed
 * to do it; a 404 would send them looking for a typo in a URL that is correct.
 */
export const notWired = (what: string) => ({
  statusCode: 501 as const,
  name: "internal_server_error" as const,
  message: `${what} is not configured.`,
})

/**
 * Refuses a domain-restricted key, for routes whose data is the whole
 * workspace's rather than one domain's. Runs after `requireApiKey`.
 *
 * ⚠ 403 AND NOT 401. The key is real; it is being used for something outside
 * what it was issued for, and telling somebody their credential is invalid
 * would send them to rotate one that is fine.
 */
export const refuseRestrictedKeys =
  (message: string): MiddlewareHandler =>
  async (c, next) => {
    if (isRestricted(c.get("auth").scopes)) {
      return c.json(
        { statusCode: 403, name: "restricted_api_key" as const, message },
        403,
      )
    }
    return next()
  }

/** The 403 `refuseRestrictedKeys` answers, for a route's documented responses. */
export const restrictedKeyResponse = errorResponse("The key is restricted to a domain.")
