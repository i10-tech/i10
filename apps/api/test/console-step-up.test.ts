import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { FreshAuthReader, SessionVerifier } from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"
import type { KeyStore } from "../src/auth/store.js"

/**
 * Proving it is you, immediately before something that cannot be undone.
 *
 * ⚠ THE PROMPT IS IN THE CONSOLE AND THE REFUSAL IS HERE, AND ONLY THE SECOND
 * ONE IS SECURITY. A dialog asking for a passkey guards a request anybody
 * holding the session cookie can make with curl; these tests are the ones that
 * would fail if that request stopped being refused.
 *
 * ⚠ AND THE FAILURE MODE TO WATCH IS OPEN, NOT CLOSED. A guard that wrongly
 * refuses is a support ticket within the hour; a guard that wrongly allows is
 * invisible until somebody's domain is gone — so "not wired up" and "Clerk did
 * not answer" both have a test, and neither of them is a 204.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"
const KEY_ID = "22222222-2222-4222-8222-222222222222"
const BEARER = { Authorization: "Bearer stub" }

const sessions: SessionVerifier = {
  verify: async () => ({ status: "signed-in", userId: "user_1" }),
}
const tenants: TenantResolver = { resolve: async () => TENANT }

const store = {
  list: async () => [],
  revoke: async () => ({ secretHash: "HASH" }),
} as unknown as KeyStore

function appWith(freshAuth?: FreshAuthReader) {
  return createApp({
    console: {
      sessions,
      tenants,
      ...(freshAuth ? { freshAuth } : {}),
      keys: {
        store,
        cache: { get: async () => null, set: async () => {}, del: async () => {} },
      },
      queries: {} as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      profile: {} as ConsoleDeps["profile"],
      marketing: {} as ConsoleDeps["marketing"],
      log: { error: () => {}, warn: () => {} },
    },
  })
}

const fresh: FreshAuthReader = async () => ({ status: "fresh" })
const stale: FreshAuthReader = async () => ({ status: "stale" })
const unknown: FreshAuthReader = async () => ({ status: "unknown" })

describe("the step-up endpoint", () => {
  it("answers 204 for a session that was proved recently", async () => {
    const res = await appWith(fresh).request("/console/step-up", { headers: BEARER })
    expect(res.status).toBe(204)
  })

  /**
   * ⚠ THE BODY IS CLERK'S HINT, AND ITS EXACT SHAPE IS WHAT MAKES THE PROMPT
   * APPEAR. `useReverification` in the browser looks for
   * `clerk_error.reason === "reverification-error"` and nothing else; a body
   * that merely says 403 leaves the customer with an error toast and no way
   * forward.
   */
  it("hands back Clerk's reverification hint for a stale one", async () => {
    const res = await appWith(stale).request("/console/step-up", { headers: BEARER })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      clerk_error: { type: "forbidden", reason: "reverification-error" },
      // ⚠ AND OUR OWN FIELDS RIDE ALONGSIDE, so every call site that has not
      // been taught about the hint still renders a sentence rather than an
      // empty toast.
      statusCode: 403,
      message: expect.any(String),
    })
  })

  /*
   * ⚠ "WE COULD NOT TELL" IS NOT "PROVE YOURSELF AGAIN". A 403 during a Clerk
   * outage sends somebody into a verification flow that cannot complete, which
   * is the same trap `requireUser` answers 503 to avoid.
   */
  it("answers 503 when Clerk could not be asked", async () => {
    const res = await appWith(unknown).request("/console/step-up", { headers: BEARER })
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("5")
  })
})

describe("the routes that cannot be undone", () => {
  it.each([
    ["/console/api-keys/" + KEY_ID, "DELETE"],
    ["/console/domains/" + KEY_ID, "DELETE"],
  ])("refuses %s on a stale session", async (path, method) => {
    const res = await appWith(stale).request(path, { method, headers: BEARER })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      clerk_error: { reason: "reverification-error" },
    })
  })

  /**
   * ⚠ THE ONE THAT WOULD MAKE THE WHOLE FEATURE DECORATIVE. `freshAuth` is
   * optional on `ConsoleDeps`, and every other optional dependency in this API
   * degrades by hiding a feature. This one must degrade by refusing: a
   * deployment that forgot to wire it should stop deletions, not accept them
   * from anybody holding a cookie.
   */
  it("refuses rather than allowing when the reader is not wired at all", async () => {
    const res = await appWith().request(`/console/api-keys/${KEY_ID}`, {
      method: "DELETE",
      headers: BEARER,
    })
    expect(res.status).toBe(501)
  })

  it("lets a freshly proved session through", async () => {
    const res = await appWith(fresh).request(`/console/api-keys/${KEY_ID}`, {
      method: "DELETE",
      headers: BEARER,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: true })
  })

  /*
   * ⚠ READS ARE NOT GUARDED, DELIBERATELY. A prompt in front of "list my keys"
   * is a prompt answered without reading, which is exactly what destroys the
   * value of the one in front of the delete.
   */
  it("does not ask anything of an ordinary read", async () => {
    const res = await appWith(stale).request("/console/api-keys", { headers: BEARER })
    expect(res.status).toBe(200)
  })
})
