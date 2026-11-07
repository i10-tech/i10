import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  applyOktaEvents,
  authenticateHook,
  presentedSecret,
  type OktaEventHookDeps,
} from "../identity/okta-event-hook.js"
import { safeError } from "../identity/directory.js"
import type { IdentityStore } from "../identity/ports.js"
import { fixedWindow, trustedClientIp, type Limit } from "../identity/rate-limit.js"

/**
 * Okta Event Hooks (#383), mounted under `/webhooks` like the other inbound
 * senders:
 *
 *   GET  /webhooks/okta/:connection   Okta's one-time verification
 *   POST /webhooks/okta/:connection   a batch of events: `data.events[]`
 *
 * What the events do is in identity/okta-event-hook.ts. This file is the HTTP
 * contract with Okta, which is narrow:
 *
 *   - Okta waits three seconds, retries once, and retries only a 5xx. A 4xx is
 *     final, so a request we cannot act on is answered 4xx and one that FAILED
 *     to be applied is a 503.
 *   - Its answer to a delivery is empty, 200 or 204.
 *
 * ⚠ AUTHENTICATED BEFORE THE BODY IS READ, with the secret the connection's
 * owner gave their Okta admin (an `Authorization` header). Nothing here acts on
 * a request that did not present it, and every way of failing is the same 401.
 *
 * ⚠ NO PER-IP LIMIT ON GOOD TRAFFIC. Okta sends from addresses shared by every
 * Okta org, so a per-IP cap would slow one customer's revocations because of
 * another's. Failed authentications are counted per IP, and an authenticated
 * connection per connection.
 */

export interface OktaEventHookRouteDeps extends OktaEventHookDeps {
  store: Pick<
    IdentityStore,
    "connectionForStart" | "identityBySubject" | "identityByEmail"
  >
  take: ReturnType<typeof fixedWindow>
  contextSecret: string | undefined
  /** `EDGE_SECRET`: what makes `cf-connecting-ip` believable. */
  edgeSecret: string | undefined
  limits?: Partial<{ authFailures: Limit; perConnection: Limit }>
}

export const HOOK_AUTH_FAILURES: Limit = { max: 60, windowSeconds: 60 }
/** Okta amalgamates events into batches, so a real org sends a few requests a minute. */
export const HOOK_PER_CONNECTION: Limit = { max: 600, windowSeconds: 60 }

/**
 * ⚠ GENEROUS, BECAUSE A 413 IS FINAL: Okta does not retry a 4xx, so a batch we
 * refused for size is revocations lost. At about 3 KB an event this is some
 * thousand events, far past any real batch, and nothing is read before the
 * caller has authenticated.
 */
const MAX_BODY = 4 * 1024 * 1024

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHALLENGE = /^[\x21-\x7E]{1,512}$/

/** For an id that is not a UUID: no query is made, but the comparison still is. */
const NO_CONNECTION = { connectionForStart: async () => null }

export function createOktaEventHooks(deps?: OktaEventHookRouteDeps) {
  const app = new Hono()
  const limits = {
    authFailures: deps?.limits?.authFailures ?? HOOK_AUTH_FAILURES,
    perConnection: deps?.limits?.perConnection ?? HOOK_PER_CONNECTION,
  }

  const tooMany = (c: Context, retryAfter: number) => {
    c.header("Retry-After", String(retryAfter))
    return c.json(
      {
        statusCode: 429,
        name: "rate_limit_exceeded" as const,
        message: "Too many requests.",
      },
      429,
    )
  }

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY,
      onError: (c) =>
        c.json(
          {
            statusCode: 413,
            name: "validation_error" as const,
            message: "That delivery is too large.",
          },
          413,
        ),
    }),
  )

  /**
   * The connection this request is for, or the response that refuses it. One
   * 401 whatever the reason (see `authenticateHook`).
   */
  async function authenticate(c: Context) {
    if (!deps) {
      return {
        refusal: c.json(
          {
            statusCode: 503 as const,
            name: "service_unavailable" as const,
            message: "Okta event hooks are not configured.",
          },
          503,
        ),
      }
    }
    c.header("Cache-Control", "no-store")
    const ip = trustedClientIp(c.req.raw.headers, deps.contextSecret, deps.edgeSecret)
    const given = presentedSecret(c.req.header("authorization"))
    const id = c.req.param("connection") ?? ""
    const connection = await authenticateHook(
      CONNECTION_ID.test(id) ? deps.store : NO_CONNECTION,
      id.toLowerCase(),
      given,
    )
    if (!connection) {
      const verdict = await deps.take(
        `okta-hook:fail:${ip ?? "unknown"}`,
        limits.authFailures,
      )
      if (!verdict.ok) return { refusal: tooMany(c, verdict.retryAfter) }
      return {
        refusal: c.json(
          {
            statusCode: 401 as const,
            name: "invalid_access" as const,
            message: "Bad token.",
          },
          401,
        ),
      }
    }
    const verdict = await deps.take(
      `okta-hook:conn:${connection.id}`,
      limits.perConnection,
    )
    if (!verdict.ok) return { refusal: tooMany(c, verdict.retryAfter) }
    return { connection }
  }

  /*
   * ⚠ THE VERIFICATION IS AUTHENTICATED TOO. Okta's secure-hooks guide
   * protects every route of the receiver, the verification included, so the
   * header is expected here. If Okta's verify call ever arrives without it,
   * the admin's Verify click is a 401; the fix is to answer the challenge
   * before `authenticate`. That is harmless (it echoes a header back) but
   * would make this URL answer for connections that do not exist.
   */
  app.get("/okta/:connection", async (c) => {
    const auth = await authenticate(c)
    if ("refusal" in auth) return auth.refusal
    const challenge = c.req.header("x-okta-verification-challenge") ?? ""
    if (!CHALLENGE.test(challenge)) {
      return c.json(
        {
          statusCode: 400,
          name: "validation_error" as const,
          message: "The verification challenge is missing.",
        },
        400,
      )
    }
    return c.json({ verification: challenge }, 200)
  })

  app.post("/okta/:connection", async (c) => {
    const auth = await authenticate(c)
    if ("refusal" in auth) return auth.refusal
    try {
      const body: unknown = await c.req.json().catch(() => null)
      const done = await applyOktaEvents(deps!, auth.connection, body)
      if (done.outcome === "malformed") {
        return c.json(
          {
            statusCode: 400,
            name: "validation_error" as const,
            message: "That is not an Okta event hook delivery.",
          },
          400,
        )
      }
      if (done.outcome === "unavailable") return unavailable(c)
      // Okta wants an empty 200 or 204.
      return c.body(null, 200)
    } catch (error) {
      deps!.log.error(
        { ...safeError(error), connectionId: auth.connection.id },
        "could not handle an Okta event hook delivery",
      )
      return unavailable(c)
    }
  })

  return app
}

/** A 5xx is the one answer Okta retries. */
function unavailable(c: Context) {
  c.header("Retry-After", "1")
  return c.json(
    {
      statusCode: 503 as const,
      name: "service_unavailable" as const,
      message: "The service is temporarily unavailable.",
    },
    503,
  )
}
