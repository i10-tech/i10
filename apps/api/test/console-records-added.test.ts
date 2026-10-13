import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountDomains } from "../src/routes/console/domains.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * "I've added the records" (2026-10-13): the press is recorded on the domain,
 * so the console waits on DNS rather than telling them to publish again. The
 * console's own watch uses the same route without the flag, and must not.
 */

function appWith(domains: Record<string, unknown>) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: "ten-1", scopes: [], mode: "live" })
    c.set("user", { userId: "user_1" })
    await next()
  })
  // Cast: the route touches two fields - see console-rename.test.ts.
  mountDomains(app, {
    log: { error() {}, warn() {} },
    domains,
  } as unknown as ConsoleDeps)
  return app
}

const verify = (app: Hono, body?: unknown) =>
  app.request("/domains/dom_1/verify", {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  })

function deps() {
  return {
    markRecordsAdded: mock(async () => {}),
    verify: mock(async () => ({ status: "not_found" as const })),
  }
}

describe("POST /console/domains/:id/verify", () => {
  it("records the person's word when they say they added the records", async () => {
    const d = deps()
    await verify(appWith(d), { added: true })
    expect(d.markRecordsAdded).toHaveBeenCalledWith("ten-1", "dom_1")
    expect(d.verify).toHaveBeenCalled()
  })

  it("records nothing for the watch's own checks", async () => {
    const d = deps()
    await verify(appWith(d))
    expect(d.markRecordsAdded).not.toHaveBeenCalled()
    expect(d.verify).toHaveBeenCalled()
  })
})
