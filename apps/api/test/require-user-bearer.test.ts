import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { requireUser, type SessionVerifier } from "../src/middleware/session.js"

/**
 * `requireUser`, in front of the session routes outside the console
 * (`/mailboxes`, the mailbox migrations): it refuses a session carried by a
 * cookie alone, the CSRF defence `requireTenant` already has (`cookieOnlyRefusal`).
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
