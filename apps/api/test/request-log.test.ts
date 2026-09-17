import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { RequestRecord } from "../src/console/queries.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { SessionVerifier } from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"

/**
 * What the console's Logs page is fed by.
 *
 * ⚠ THE VALUE OF THIS LOG IS THAT IT IS COMPLETE, which is why it is a wildcard
 * middleware rather than a call in each route — a log that covers the endpoints
 * whoever added it remembered answers "did my server actually call you?"
 * wrongly in exactly the case somebody opens it for. These pin the two halves
 * that could go wrong quietly: that an API-key request IS recorded with the
 * route pattern rather than the concrete URL, and that a console page load is
 * NOT, because a person clicking around the dashboard must not bury the one
 * integration call they came here to find.
 */

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const TENANT = "11111111-1111-4111-8111-111111111111"

const apiKeyAuth = {
  lookup: {
    byHash: async () => ({
      id: "key-1",
      tenantId: TENANT,
      scopes: ["emails:send"],
      mode: "live" as const,
      revokedAt: null,
      expiresAt: null,
    }),
  },
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
  ttlSeconds: 60,
}

const sessions: SessionVerifier = {
  verify: async () => ({ status: "signed-in", userId: "user_1" }),
}
const tenants: TenantResolver = { resolve: async () => TENANT }

function appWith(recorded: RequestRecord[], failRecord = false) {
  return createApp({
    apiKeyAuth,
    // ⚠ NO `emailLookup`, SO `GET /emails/{id}` ANSWERS 501. That is deliberate:
    // what is under test is that the request is LOGGED, and a route that fails
    // is exactly the kind a customer opens this page to find.
    console: {
      sessions,
      tenants,
      queries: {
        recordRequest: async (input: RequestRecord) => {
          if (failRecord) throw new Error("the log table is full")
          recorded.push(input)
        },
      } as unknown as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      marketing: {} as ConsoleDeps["marketing"],
      profile: {} as ConsoleDeps["profile"],
      log: { error: () => {}, warn: () => {} },
    },
  })
}

/** The insert is fire-and-forget, so let its microtask run before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("the API request log", () => {
  it("records an API-key request against the tenant and the key", async () => {
    const recorded: RequestRecord[] = []

    const response = await appWith(recorded).request(
      "/emails/0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
      { headers: { Authorization: `Bearer ${KEY}` } },
    )
    await settle()

    expect(response.status).toBe(501)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      tenantId: TENANT,
      apiKeyId: "key-1",
      method: "GET",
      // ⚠ THE ROUTE PATTERN, NOT THE URL — the invariant `core.api_requests`
      // states. The concrete path would make every message id its own row and
      // bury the signal under its own volume.
      path: "/emails/:id",
      status: 501,
    })
    expect(recorded[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  /**
   * ⚠ A CONSOLE PAGE LOAD IS NOT AN API REQUEST, AND THE GUARD THAT SEPARATES
   * THEM IS `requireTenant` SETTING AN EMPTY KEY ID. If that ever changed to a
   * placeholder, every click in the dashboard would land in the customer's own
   * request log — which is the fastest possible way to make the page useless.
   */
  it("does not record a console request made with a session", async () => {
    const recorded: RequestRecord[] = []

    await appWith(recorded).request("/console/me", {
      headers: { Authorization: "Bearer stub-session" },
    })
    await settle()

    expect(recorded).toEqual([])
  })

  it("does not record an unauthenticated request", async () => {
    const recorded: RequestRecord[] = []

    const response = await appWith(recorded).request("/healthz")
    await settle()

    expect(response.status).toBe(200)
    expect(recorded).toEqual([])
  })

  /**
   * ⚠ A BROKEN LOG MUST NOT BREAK THE SEND PATH. The insert happens after the
   * response is built and is deliberately not awaited; if it could fail the
   * request, a full log table would stop customers sending mail. The failure is
   * reported to the API's own logger instead, so a silently empty page stays
   * distinguishable from a genuinely quiet account.
   */
  it("still answers normally when the log write throws", async () => {
    const response = await appWith([], true).request(
      "/emails/0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
      { headers: { Authorization: `Bearer ${KEY}` } },
    )
    await settle()

    expect(response.status).toBe(501)
  })
})
