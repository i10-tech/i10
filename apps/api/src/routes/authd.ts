import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { PassthroughAnswer } from "../identity/ldap.js"
import { equalSecrets } from "../webhooks/signing.js"

/**
 * What `services/authd` asks of the API (#344).
 *
 *   POST /internal/authd/passthrough  { connectionId } -> where the connection's
 *                                     managed accounts' passwords are asked:
 *                                     off, its LDAP directory (settings
 *                                     decrypted) or its Okta org (#383)
 *
 * ⚠ THE LDAP ANSWER CARRIES THE COMPANY'S SERVICE ACCOUNT SECRET IN THE CLEAR, so
 * the caller is checked first and in constant time against `AUTHD_API_SECRET`,
 * before the body is even read. No secret configured is a 503, never "open".
 * Nothing is cached by anyone on the way (`no-store`); authd keeps an answer
 * in memory for at most a minute. The Okta answer holds no secret at all.
 *
 * ⚠ EVERY FAILURE IS A 503, NEVER `enabled: false`. authd turns a 503 into
 * "directory unavailable" for managed accounts; an "off" given on an outage
 * would read as "this connection has no IMAP" and be cached as such.
 */

export interface InternalAuthdDeps {
  /** `AUTHD_API_SECRET`. Absent: every call is 503. */
  secret: string | undefined
  passthrough(connectionId: string): Promise<PassthroughAnswer>
  log: { error: (o: object, m: string) => void }
}

const Body = z.object({ connectionId: z.uuid() }).strict()

const unavailable = (c: Context) => {
  c.header("Retry-After", "5")
  return c.json(
    {
      statusCode: 503,
      name: "service_unavailable",
      message: "Temporarily unavailable.",
    },
    503,
  )
}

export function createInternalAuthdRoutes(deps?: InternalAuthdDeps) {
  const app = new Hono()
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024,
      onError: (c) =>
        c.json(
          { statusCode: 413, name: "validation_error", message: "Too large." },
          413,
        ),
    }),
  )

  app.post("/passthrough", async (c) => {
    if (!deps?.secret) return unavailable(c)
    const header = c.req.header("Authorization") ?? ""
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!equalSecrets(deps.secret, given))
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Bad token." },
        401,
      )

    const parsed = Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        {
          statusCode: 422,
          name: "validation_error",
          message: "connectionId must be a uuid.",
        },
        422,
      )
    try {
      const answer = await deps.passthrough(parsed.data.connectionId)
      c.header("Cache-Control", "no-store")
      return c.json(answer)
    } catch (error) {
      deps.log.error(
        { err: error instanceof Error ? error.name : "unknown" },
        "could not answer authd's pass-through lookup",
      )
      return unavailable(c)
    }
  })

  return app
}
