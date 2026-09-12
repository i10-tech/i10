import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it, mock } from "bun:test"

// ⚠ `mock.module` IS NOT HOISTED, WHICH IS WHY THE IMPORT BELOW IS DYNAMIC.
// Vitest lifted `vi.mock` above every statement in the file and needed
// `vi.hoisted` to get the double defined in time; bun runs this line where it
// is written, so the double is an ordinary const — but a STATIC
// `import { createApp } from "../src/app.js"` would then be evaluated before
// this line ran, and the route would hold the real writer. The `await import`
// is load-bearing, not a leftover.
const applyClerkEvent = mock()
mock.module("../src/projection/writer.js", () => ({ applyClerkEvent }))

const { createApp } = await import("../src/app.js")

const SECRET =
  "whsec_" + Buffer.from("a-32-byte-test-signing-key-here!").toString("base64")
const HOSTED = ["i10.tech"]

/** A database that fails loudly if the route touches it. */
const forbiddenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be reached")
    },
  },
) as never

function signed(body: string, id = "msg_1", at = new Date()) {
  const ts = String(Math.floor(at.getTime() / 1000))
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64")
  const mac = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")
  return {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${mac}`,
    "Content-Type": "application/json",
  }
}

function app(configured = true) {
  return createApp(
    configured
      ? {
          clerkWebhooks: {
            db: forbiddenDb,
            signingSecret: SECRET,
            hostedDomains: HOSTED,
          },
        }
      : {},
  )
}

const event = JSON.stringify({
  type: "user.created",
  data: { id: "user_1", email_addresses: [], primary_email_address_id: null },
})

beforeEach(() => {
  applyClerkEvent.mockReset()
  applyClerkEvent.mockResolvedValue({ outcome: "upserted", email: "a@i10.tech" })
})

describe("POST /webhooks/clerk", () => {
  it("applies a correctly signed event", async () => {
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: signed(event),
      body: event,
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, outcome: "upserted" })

    expect(applyClerkEvent).toHaveBeenCalledTimes(1)
    const [, eventId, type, , domains] = applyClerkEvent.mock.calls[0]!
    expect(eventId).toBe("msg_1")
    expect(type).toBe("user.created")
    expect(domains).toEqual(HOSTED)
  })

  // ⚠ The boundary. A forged event could create a mailbox on a domain we host
  // or silence somebody else's, so nothing may reach the database unverified.
  it("rejects a bad signature without touching the database", async () => {
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: { ...signed(event), "svix-signature": "v1,ZmFrZQ==" },
      body: event,
    })
    expect(res.status).toBe(401)
    expect(applyClerkEvent).not.toHaveBeenCalled()
  })

  it("rejects a tampered body", async () => {
    const headers = signed(event)
    const tampered = JSON.stringify({
      type: "user.deleted",
      data: { id: "user_victim" },
    })
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers,
      body: tampered,
    })
    expect(res.status).toBe(401)
    expect(applyClerkEvent).not.toHaveBeenCalled()
  })

  it("rejects a replayed request", async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000)
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: signed(event, "msg_old", old),
      body: event,
    })
    expect(res.status).toBe(401)
    expect(applyClerkEvent).not.toHaveBeenCalled()
  })

  it("rejects missing signature headers", async () => {
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event,
    })
    expect(res.status).toBe(401)
    expect(applyClerkEvent).not.toHaveBeenCalled()
  })

  // Signed by us and still unparseable means a contract change, not an attack.
  // Retrying cannot fix it, so it comes off the queue loudly.
  it("returns 400 for a signed body that is not JSON", async () => {
    const body = "not json"
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: signed(body),
      body,
    })
    expect(res.status).toBe(400)
    expect(applyClerkEvent).not.toHaveBeenCalled()
  })

  it("returns 400 when the event has no type", async () => {
    const body = JSON.stringify({ data: { id: "user_1" } })
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: signed(body),
      body,
    })
    expect(res.status).toBe(400)
    expect(applyClerkEvent).not.toHaveBeenCalled()
  })

  // Svix retries anything non-2xx, which is what we want for a genuine failure.
  it("returns 500 when applying the event fails", async () => {
    applyClerkEvent.mockRejectedValue(new Error("connection refused"))
    const res = await app().request("/webhooks/clerk", {
      method: "POST",
      headers: signed(event),
      body: event,
    })
    expect(res.status).toBe(500)
  })

  it.each(["duplicate", "stale", "ignored", "removed"] as const)(
    "acknowledges a %s outcome so Svix stops retrying",
    async (outcome) => {
      applyClerkEvent.mockResolvedValue({ outcome })
      const res = await app().request("/webhooks/clerk", {
        method: "POST",
        headers: signed(event),
        body: event,
      })
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({ outcome })
    },
  )

  // A 404 here would look like Clerk having the wrong URL, rather than saying
  // what is actually wrong.
  it("answers 503, not 404, when webhooks are unconfigured", async () => {
    const res = await app(false).request("/webhooks/clerk", {
      method: "POST",
      headers: signed(event),
      body: event,
    })
    expect(res.status).toBe(503)
  })
})

describe("GET /readyz", () => {
  it("reports ok when the database answers", async () => {
    const res = await createApp({ pingDb: async () => {} }).request("/readyz")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, checks: { database: true } })
  })

  // A pod whose database is gone must stop receiving traffic.
  it("reports 503 when the database does not", async () => {
    const res = await createApp({
      pingDb: async () => {
        throw new Error("down")
      },
    }).request("/readyz")
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      ok: false,
      checks: { database: false },
    })
  })
})
