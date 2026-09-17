import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { SessionVerifier } from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"

/**
 * What a typo in the address bar does.
 *
 * ⚠ EVERY `:id` ON THIS SURFACE IS A UUID, AND POSTGRES DOES NOT TREAT A BAD
 * ONE AS "NO ROWS". `where id = 'banana'` raises `22P02` before the planner
 * looks at a single tuple, so without the translation this is a 500: an entry
 * in the error budget and a Sentry issue, for a stale bookmark. These pin that
 * it is a 422, and — just as important — that a genuine failure is still a 500.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"
const BEARER = { Authorization: "Bearer stub" }

const sessions: SessionVerifier = {
  verify: async () => ({ status: "signed-in", userId: "user_1" }),
}

const tenants: TenantResolver = { resolve: async () => TENANT }

/** A Postgres error as the `postgres` driver raises it: code, no niceties. */
function pgError(code: string): Error {
  const error = new Error(`postgres error ${code}`)
  Object.assign(error, { code })
  return error
}

/**
 * ⚠ THE WHOLE APP, NOT THE CONSOLE ROUTER ALONE, BECAUSE THE TRANSLATION LIVES
 * IN `app.onError`. It has to: Hono's `compose` catches a handler's throw at
 * the level below any wrapping middleware and routes it straight to the error
 * handler, and `app.route()` discards a sub-app's own. Testing the router in
 * isolation would test a path that does not exist in the running server.
 */
function appWith(thrown: Error, reported: unknown[] = []) {
  const marketing = {
    getContact: async () => {
      throw thrown
    },
  } as unknown as ConsoleDeps["marketing"]

  return createApp({
    reportError: (error) => {
      reported.push(error)
    },
    console: {
      sessions,
      tenants,
      marketing,
      queries: {} as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      profile: {} as ConsoleDeps["profile"],
      log: { error: () => {}, warn: () => {} },
    },
  })
}

describe("a malformed id", () => {
  it("is a 422 with an explanation, not a 500", async () => {
    const response = await appWith(pgError("22P02")).request("/console/contacts/banana", {
      headers: BEARER,
    })

    expect(response.status).toBe(422)
    const body = (await response.json()) as { name: string; message: string }
    expect(body.name).toBe("validation_error")
    expect(body.message).toContain("uuid")
  })

  /**
   * ⚠ THE CONDITION HAS TO BE NARROW, WHICH IS THE HALF THAT COULD GO WRONG
   * QUIETLY. A catch that answered 422 for any database error would turn a
   * deadlock, a failed constraint or a dead connection into "your request was
   * malformed" — telling a customer their input is wrong while our database is
   * on fire, and hiding the outage from our own error reporting.
   */
  it("does not swallow any other database failure", async () => {
    const reported: unknown[] = []
    const response = await appWith(pgError("40P01"), reported).request(
      "/console/contacts/banana",
      { headers: BEARER },
    )

    expect(response.status).toBe(500)
    // ⚠ AND IT REACHED THE REPORTER. A 422 that quietly ate a deadlock would
    // leave us blind to the one failure mode worth paging on.
    expect(reported).toHaveLength(1)
  })

  /**
   * ⚠ THE 422 IS NOT REPORTED, WHICH IS HALF THE POINT OF THE CHANGE. A stale
   * bookmark is not an incident, and a crawler walking truncated links would
   * otherwise open one Sentry issue per request.
   */
  it("does not report a malformed id as an error", async () => {
    const reported: unknown[] = []
    await appWith(pgError("22P02"), reported).request("/console/contacts/banana", {
      headers: BEARER,
    })

    expect(reported).toEqual([])
  })
})
