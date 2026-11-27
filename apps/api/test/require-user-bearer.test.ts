import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { ClerkClient } from "@clerk/backend"
import {
  clerkSessions,
  requireUser,
  type SessionVerifier,
} from "../src/middleware/session.js"
import { clerkAuthAppIdentity } from "../src/routes/devices.js"

/**
 * `requireUser`, in front of the session routes outside the console
 * (`/mailboxes`, the mailbox migrations): it refuses a session carried by a
 * cookie alone, the CSRF defence `requireTenant` already has (`cookieOnlyRefusal`).
 * The verifiers below refuse it too, for routes that call them directly.
 */

function appWith() {
  let verified = 0
  const sessions: SessionVerifier = {
    verify: async () => {
      verified += 1
      return { status: "signed-in", userId: "user_1" }
    },
  }
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("sessionAuth", sessions)
    await next()
  })
  app.post("/mailboxes", requireUser, (c) => c.json({ userId: c.get("user").userId }))
  return { app, verified: () => verified }
}

describe("requireUser", () => {
  it("refuses a cookie-only request before verifying the session", async () => {
    const { app, verified } = appWith()
    const response = await app.request("/mailboxes", {
      method: "POST",
      headers: { Cookie: "__session=a-good-session", "Content-Type": "text/plain" },
    })
    expect(response.status).toBe(401)
    expect(((await response.json()) as { message: string }).message).toContain(
      "cookie alone",
    )
    expect(verified()).toBe(0)
  })

  it("passes a session sent as a Bearer header", async () => {
    const { app } = appWith()
    const response = await app.request("/mailboxes", {
      method: "POST",
      headers: { Authorization: "Bearer a-good-session" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: "user_1" })
  })
})

/** A Clerk client that would accept any request, cookie or header, and counts its calls. */
function acceptingClerk() {
  let calls = 0
  const clerk = {
    authenticateRequest: async () => {
      calls += 1
      return {
        isAuthenticated: true,
        toAuth: () => ({ userId: "user_1", sessionId: "sess_1" }),
      }
    },
  } as unknown as ClerkClient
  return { clerk, calls: () => calls }
}

const cookieOnly = () =>
  new Request("https://api.i10.tech/devices/remember", {
    method: "POST",
    headers: { Cookie: "__session=a-good-session" },
  })
const withBearer = () =>
  new Request("https://api.i10.tech/devices/remember", {
    method: "POST",
    headers: { Authorization: "Bearer a-good-session" },
  })

/**
 * The verifiers refuse a cookie-only request themselves, so a route that calls
 * one directly (the auth app's `/devices` and `/sso` routes, the export
 * download) is covered without going through `requireUser`.
 */
describe("the session verifiers", () => {
  it("clerkSessions treats a cookie-only request as signed out without asking Clerk", async () => {
    const { clerk, calls } = acceptingClerk()
    const sessions = clerkSessions(clerk)
    expect(await sessions.verify(cookieOnly())).toEqual({ status: "signed-out" })
    expect(calls()).toBe(0)
    expect(await sessions.verify(withBearer())).toEqual({
      status: "signed-in",
      userId: "user_1",
    })
  })

  it("clerkAuthAppIdentity treats a cookie-only request as signed out without asking Clerk", async () => {
    const { clerk, calls } = acceptingClerk()
    const identify = clerkAuthAppIdentity(clerk, { authorizedParties: [] })
    expect(await identify(cookieOnly())).toEqual({ status: "signed-out" })
    expect(calls()).toBe(0)
    expect(await identify(withBearer())).toEqual({
      status: "signed-in",
      userId: "user_1",
      sessionId: "sess_1",
    })
  })
})
