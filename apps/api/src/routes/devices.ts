import type { ClerkClient } from "@clerk/backend"
import { Hono } from "hono"
import { freshAfterSignUp, resume, type ResumeClerk } from "../devices/resume.js"
import {
  isPresentable,
  type DeviceStore,
  type PresentedDevice,
} from "../devices/store.js"

/**
 * Saved accounts that sign straight back in (#192), for the auth app only.
 *
 * The auth app's server calls these; the browser never does. It keeps the
 * device secret in an httpOnly cookie on its own origin and forwards it here.
 *
 *   POST /devices/remember  after a real sign-in. Session required.
 *   POST /devices/resume    a card was pressed. The secret is the credential.
 *   POST /devices/forget    the card's × was pressed. The secret is the proof.
 *   POST /devices/fresh     just signed up: a fresh session, so adding a
 *                           passkey does not ask for the password just set.
 *
 * ⚠ OUTSIDE THE OPENAPI DOCUMENT. This is how our own sign-in page works, not
 * part of the product's API.
 *
 * ⚠ THE SESSION ON `remember` IS VERIFIED AGAINST THE AUTH ORIGIN, NOT THE
 * CONSOLE'S. The token is minted on auth.i10.tech, so its `azp` is that origin;
 * the console's allowlist would refuse it, and an empty allowlist would accept
 * a token from any app on the Clerk instance. Unset, the route refuses.
 */

export type Identity =
  | { status: "signed-in"; userId: string; sessionId: string }
  | { status: "signed-out" }
  | { status: "unavailable" }

export type IdentityReader = (request: Request) => Promise<Identity>

export interface DeviceRouteDeps {
  store: DeviceStore
  clerk: ResumeClerk
  /** Absent when no auth origin is configured: `remember` then answers 501. */
  identify?: IdentityReader
  log?: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void }
}

/** More than the sign-in page ever keeps; a cap so a body cannot ask for fifty lookups. */
const MAX_PRIOR = 8

export function clerkAuthAppIdentity(
  clerk: ClerkClient,
  options: {
    authorizedParties: readonly string[]
    log?: { error: (o: object, m: string) => void }
  },
): IdentityReader {
  return async (request) => {
    try {
      const state = await clerk.authenticateRequest(request, {
        authorizedParties: [...options.authorizedParties],
      })
      if (!state.isAuthenticated) return { status: "signed-out" }
      const { userId, sessionId } = state.toAuth() as {
        userId?: string | null
        sessionId?: string | null
      }
      return userId && sessionId
        ? { status: "signed-in", userId, sessionId }
        : { status: "signed-out" }
    } catch (error) {
      options.log?.error(
        { err: String(error) },
        "clerk could not verify an auth-app session",
      )
      return { status: "unavailable" }
    }
  }
}

const unavailable = {
  statusCode: 503,
  name: "service_unavailable",
  message: "Could not check that right now. Retry shortly.",
} as const

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export function createDeviceRoutes(deps?: DeviceRouteDeps) {
  const app = new Hono()

  app.use("*", async (c, next) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 501,
          name: "internal_server_error",
          message: "Saved accounts are not configured.",
        },
        501,
      )
    }
    await next()
  })

  app.post("/remember", async (c) => {
    const { store, identify, log } = deps!
    if (!identify) {
      return c.json(
        {
          statusCode: 501,
          name: "internal_server_error",
          message: "AUTH_ORIGINS is not set.",
        },
        501,
      )
    }

    const who = await identify(c.req.raw)
    if (who.status === "signed-out") {
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Not signed in." },
        401,
      )
    }
    if (who.status === "unavailable") return c.json(unavailable, 503)

    const body = (await readJson(c.req.raw)) as { prior?: unknown } | null
    const prior: PresentedDevice[] = Array.isArray(body?.prior)
      ? body.prior.filter(isPresentable).slice(0, MAX_PRIOR)
      : []

    try {
      const device = await store.remember({
        userId: who.userId,
        sessionId: who.sessionId,
        prior,
      })
      return c.json(device, 200)
    } catch (error) {
      log?.error({ err: String(error) }, "could not remember a device")
      return c.json(unavailable, 503)
    }
  })

  app.post("/fresh", async (c) => {
    const { clerk, identify, log } = deps!
    if (!identify) {
      return c.json(
        {
          statusCode: 501,
          name: "internal_server_error",
          message: "AUTH_ORIGINS is not set.",
        },
        501,
      )
    }

    const who = await identify(c.req.raw)
    if (who.status === "signed-out") {
      return c.json(
        { statusCode: 401, name: "invalid_access", message: "Not signed in." },
        401,
      )
    }
    if (who.status === "unavailable") return c.json(unavailable, 503)

    try {
      return c.json(await freshAfterSignUp(who, { clerk }), 200)
    } catch (error) {
      log?.warn({ err: String(error) }, "could not refresh a sign-up session")
      return c.json(unavailable, 503)
    }
  })

  app.post("/resume", async (c) => {
    const { store, clerk, log } = deps!
    const body = await readJson(c.req.raw)
    if (!isPresentable(body)) return c.json({ outcome: "forget" as const }, 200)

    try {
      return c.json(
        await resume({ id: body.id, secret: body.secret }, { store, clerk }),
        200,
      )
    } catch (error) {
      /*
       * ⚠ 503, AND THE PAGE FALLS BACK TO THE ORDINARY SIGN-IN. Clerk or the
       * database being down must never read as "this entry is dead" - that
       * would drop every saved account during an outage - and must never let
       * anybody in either.
       */
      log?.warn({ err: String(error) }, "could not resume a remembered device")
      return c.json(unavailable, 503)
    }
  })

  app.post("/forget", async (c) => {
    const { store, log } = deps!
    const body = await readJson(c.req.raw)
    if (!isPresentable(body)) return c.body(null, 204)

    try {
      await store.forget({ id: body.id, secret: body.secret })
      return c.body(null, 204)
    } catch (error) {
      log?.warn({ err: String(error) }, "could not forget a remembered device")
      return c.json(unavailable, 503)
    }
  })

  return app
}
