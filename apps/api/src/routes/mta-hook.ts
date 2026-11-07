import { Hono } from "hono"
import { decideHook, parseHookRequest, type HookDeps } from "../mail/mta-hook.js"
import { equalSecrets } from "../webhooks/signing.js"
import type { Logger } from "../webhooks/events.js"

/**
 * Stalwart's MTA hook for mailbox submissions (B5, #380).
 *
 * ⚠ CLUSTER-INTERNAL, BUT THAT IS NOT AUTHENTICATION. Every pod in i10-prod can
 * reach the API (`allow-same-namespace`), and this endpoint decides whether a
 * workspace's people may send mail. Stalwart presents the shared secret as a
 * Bearer token (`httpAuth` on the MtaHook); nothing is read before it matches.
 *
 * ⚠ THE STATUS CODES ARE THE FAILURE MODE. Stalwart treats any non-2xx, a
 * timeout or an unreachable endpoint as an error and, with `tempFailOnError`
 * on, answers the client `451 4.3.5` so it retries. So a missing secret (503),
 * a wrong one (401), a body we cannot read (400) and a decision that threw (500)
 * all become a tempfail - never an accept. The only 200s are decisions.
 *
 * ⚠ A WRONG SECRET IS THE ONE THAT READS AS AN OUTAGE: every mailbox send
 * tempfails until the two sides match. Look for `rejected an MTA hook call` in
 * the API log.
 */

export interface MtaHookRouteDeps extends HookDeps {
  /** The `httpAuth` bearer token configured on Stalwart's MtaHook. */
  secret: string
  log: Logger
}

export function createMtaHookRoutes(deps?: MtaHookRouteDeps) {
  const app = new Hono()

  app.post("/", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "The MTA hook is not configured.",
        },
        503,
      )
    }

    const header = c.req.header("Authorization") ?? ""
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    // ⚠ CONSTANT TIME, as `/internal/queue-depth` compares its token.
    if (!equalSecrets(deps.secret, given)) {
      deps.log.warn({}, "rejected an MTA hook call")
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Bad token." },
        401,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      body = null
    }
    const request = parseHookRequest(body)
    if (!request) {
      // Authenticated and still unreadable: a Stalwart version that changed the
      // request. Failing is right - accepting would switch the check off.
      deps.log.error({}, "MTA hook body is not a Stalwart request")
      return c.json(
        { statusCode: 400, name: "validation_error", message: "Unreadable request." },
        400,
      )
    }

    try {
      return c.json(await decideHook(request, deps), 200)
    } catch (err) {
      // ⚠ NOT AN ACCEPT. The database being down is the likely cause, and the
      // client's retry is exactly the right response to it.
      deps.log.error({ err }, "MTA hook could not decide")
      return c.json(
        {
          statusCode: 500,
          name: "internal_server_error",
          message: "Could not decide.",
        },
        500,
      )
    }
  })

  return app
}
