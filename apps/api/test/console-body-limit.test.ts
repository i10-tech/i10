import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { SessionVerifier } from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"

/**
 * The cap on what a signed-in browser may send.
 *
 * ⚠ A SIGNED-IN CALLER IS STILL AN UNTRUSTED CALLER. `await c.req.json()` on a
 * 500 MB body buffers the whole thing in this process before a line of
 * validation runs, so one account could take the API down for every tenant on
 * it. What these pin is that the limit exists, that it is enforced as the body
 * STREAMS rather than from a `Content-Length` header nobody has to send, and —
 * the part that is easy to get wrong — that the CSV import's larger limit is
 * scoped to exactly one route.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"
const BEARER = { Authorization: "Bearer stub" }

const sessions: SessionVerifier = {
  verify: async () => ({ status: "signed-in", userId: "user_1" }),
}
const tenants: TenantResolver = { resolve: async () => TENANT }

/**
 * ⚠ THE WHOLE APP, MOUNTED AT `/console`, NOT THE BARE ROUTER. This is the
 * difference between a test that pins the behaviour and one that pins nothing:
 * the exemption is matched against a path, and the bare router sees
 * `/contacts/import` while the real server sees `/console/contacts/import`. An
 * earlier version of this file exercised the bare router, passed, and would
 * have shipped an import that broke at 256 KB in production only.
 */
function app() {
  return createApp({
    console: {
      sessions,
      tenants,
      marketing: {
        importContacts: async (_tenantId: string, csv: string) => ({
          parsed: csv.length,
          created: 0,
          updated: 0,
          invalid: 0,
        }),
        createSegment: async () => ({ id: "s1" }),
      } as unknown as ConsoleDeps["marketing"],
      queries: {} as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      profile: {} as ConsoleDeps["profile"],
        log: { error: () => {}, warn: () => {} },
    },
  })
}

/**
 * ⚠ SENT AS A STREAM WITH NO `Content-Length`, WHICH IS THE WHOLE POINT. A
 * header is a claim: it is absent on a chunked request and is not binding on
 * any request. If the limit were a header check, this body would sail past it.
 */
function chunked(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(0x61) // "a"
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) {
        controller.close()
        return
      }
      const size = Math.min(chunk.length, bytes - sent)
      controller.enqueue(chunk.subarray(0, size))
      sent += size
    },
  })
}

const post = (path: string, bytes: number) =>
  app().request(`/console${path}`, {
    method: "POST",
    headers: { ...BEARER, "content-type": "text/csv" },
    body: chunked(bytes),
    // ⚠ REQUIRED BY THE FETCH SPEC FOR A STREAMING REQUEST BODY, and absent
    // from the DOM `RequestInit` type, which is why it goes in by cast rather
    // than as a property. Without it, a runtime that enforces the spec refuses
    // to send the stream at all and the test would pass for the wrong reason.
    duplex: "half",
  } as RequestInit & { duplex: "half" })

describe("console body limits", () => {
  it("refuses an ordinary mutation with a body over 256 KB", async () => {
    const response = await post("/segments", 512 * 1024)
    expect(response.status).toBe(413)
  })

  /**
   * ⚠ THE IMPORT KEEPS THE 20 MB IT DOCUMENTS. The two limits must not nest:
   * `bodyLimit` wraps the request stream, so a 256 KB wrapper around a 20 MB
   * one caps at 256 KB and the import breaks at exactly the size the interface
   * tells people to use.
   */
  it("lets the contacts import send more than 256 KB", async () => {
    const response = await post("/contacts/import", 512 * 1024)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ parsed: 512 * 1024 })
  })

  /**
   * ⚠ AND THE EXEMPTION CANNOT BE WIDENED BY INVENTING SEGMENTS. The first
   * version matched `c.req.path.endsWith("/contacts/import")`, which also
   * matched paths with no handler at all — a wildcard middleware still runs
   * before the 404, so the process read twenty megabytes and then threw them
   * away. `except()` matches the router's own route pattern instead.
   */
  it("does not extend the import's limit to a path that merely ends with it", async () => {
    const response = await post("/nonsense/contacts/import", 512 * 1024)
    expect(response.status).toBe(413)
  })
})
