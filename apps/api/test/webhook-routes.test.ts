import { describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app.js"
import { lastEvent } from "../src/send/lookup.js"

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"

const apiKeyAuth = {
  lookup: {
    byHash: async () => ({
      id: "key-1",
      tenantId: "ten-1",
      scopes: ["emails:send"],
      mode: "live",
      revokedAt: null,
      expiresAt: null,
    }),
  },
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
  ttlSeconds: 60,
}

const email = {
  object: "email" as const,
  id: ID,
  from: "hello@i10.tech",
  to: ["user@example.com"],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: "Hi",
  html: null,
  text: "body",
  created_at: "2026-09-03T10:00:00.000Z",
  scheduled_at: null,
  last_event: "delivered" as const,
}

const endpoint = {
  object: "webhook_endpoint" as const,
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb",
  url: "https://hooks.example.com/i10",
  events: ["email.bounced" as const],
  description: null,
  enabled: true,
  created_at: "2026-09-03T10:00:00.000Z",
}

const get = (app: ReturnType<typeof createApp>, path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${KEY}` } })

describe("GET /emails/{id}", () => {
  it("returns the message", async () => {
    const app = createApp({ apiKeyAuth, emailLookup: { get: async () => email } })
    const res = await get(app, `/emails/${ID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: ID, last_event: "delivered" })
  })

  it("passes the caller's own tenant, never one from the request", async () => {
    const lookup = vi.fn(async () => email)
    const app = createApp({ apiKeyAuth, emailLookup: { get: lookup } })
    await get(app, `/emails/${ID}`)
    expect(lookup).toHaveBeenCalledWith("ten-1", ID)
  })

  // ⚠ 404, NOT 403, FOR ANOTHER TENANT'S ID. Row level security returns
  // nothing, and a 403 would confirm the id exists — turning a status endpoint
  // into an oracle for enumerating other customers' message ids.
  it("answers 404 for a message that is not this tenant's", async () => {
    const app = createApp({ apiKeyAuth, emailLookup: { get: async () => null } })
    const res = await get(app, `/emails/${ID}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ name: "not_found" })
  })

  it("rejects an id that is not a uuid", async () => {
    const app = createApp({ apiKeyAuth, emailLookup: { get: async () => email } })
    expect((await get(app, "/emails/not-an-id")).status).toBe(422)
  })

  it("requires a key", async () => {
    const app = createApp({ apiKeyAuth, emailLookup: { get: async () => email } })
    expect((await app.request(`/emails/${ID}`)).status).toBe(401)
  })

  // ⚠ 501 RATHER THAN 404 WHEN UNCONFIGURED. A 404 would claim the message does
  // not exist, which is a different and wrong statement.
  it("answers 501 when the lookup is not wired", async () => {
    const app = createApp({ apiKeyAuth })
    expect((await get(app, `/emails/${ID}`)).status).toBe(501)
  })
})

describe("last_event", () => {
  // ⚠ THE ROW SAYS `sent` FOR A MESSAGE THAT BOUNCED AN HOUR AGO. Reporting the
  // column alone would tell a customer their mail was fine.
  it("prefers the event log over the row's status", () => {
    expect(lastEvent("sent", null, ["sent", "bounced"])).toBe("bounced")
  })

  // ⚠ SEVERITY, NOT TIME. SES publishes Delivery for one recipient and Bounce
  // for another on the same message, in whatever order the receivers answer —
  // so ordering by timestamp makes the same message read differently on two
  // requests.
  it("is deterministic when delivery and bounce both arrive", () => {
    expect(lastEvent("sent", null, ["bounced", "delivered"])).toBe("bounced")
    expect(lastEvent("sent", null, ["delivered", "bounced"])).toBe("bounced")
  })

  it("falls back to the row when there are no events", () => {
    expect(lastEvent("queued", null, [])).toBe("queued")
    expect(lastEvent("sending", null, [])).toBe("sending")
    expect(lastEvent("failed", null, [])).toBe("failed")
  })

  // "queued" for a send scheduled next Tuesday reads as stuck.
  it("distinguishes a scheduled message from a queued one", () => {
    const future = new Date(Date.now() + 86_400_000)
    expect(lastEvent("queued", future, [])).toBe("scheduled")
  })

  it("treats a past schedule as ordinary queueing", () => {
    expect(lastEvent("queued", new Date(0), [])).toBe("queued")
  })

  it("ignores event types it does not know", () => {
    expect(lastEvent("sent", null, ["opened", "clicked"])).toBe("sent")
  })
})

describe("/webhook-endpoints", () => {
  const store = {
    create: vi.fn(async () => ({
      status: "created" as const,
      endpoint: { ...endpoint, secret: "whsec_abc" },
    })),
    list: vi.fn(async () => [endpoint]),
    remove: vi.fn(async () => true),
    rotateSecret: vi.fn(async () => ({ ...endpoint, secret: "whsec_new" })),
  }

  const app = () => createApp({ apiKeyAuth, webhookEndpoints: store })

  const post = (path: string, body: unknown) =>
    app().request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(body),
    })

  // ⚠ ONCE, AND NEVER AGAIN. There is no "show me my signing secret" endpoint on
  // purpose: such a call is a better target than the database it would read.
  it("returns the secret on creation", async () => {
    const res = await post("/webhook-endpoints", {
      url: "https://hooks.example.com/i10",
      events: ["email.bounced"],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ secret: "whsec_abc" })
  })

  it("never returns a secret when listing", async () => {
    const res = await get(app(), "/webhook-endpoints")
    expect(JSON.stringify(await res.json())).not.toContain("whsec")
  })

  it("refuses an endpoint subscribed to nothing", async () => {
    const res = await post("/webhook-endpoints", {
      url: "https://hooks.example.com/i10",
      events: [],
    })
    expect(res.status).toBe(422)
  })

  it("refuses an unknown event name", async () => {
    const res = await post("/webhook-endpoints", {
      url: "https://hooks.example.com/i10",
      events: ["email.opened"],
    })
    expect(res.status).toBe(422)
  })

  it("surfaces a rejected URL as a 422 with the reason", async () => {
    const rejecting = createApp({
      apiKeyAuth,
      webhookEndpoints: {
        ...store,
        create: async () => ({ status: "rejected", reason: "`url` must use https." }),
      },
    })
    const res = await rejecting.request("/webhook-endpoints", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        url: "https://hooks.example.com/i10",
        events: ["email.bounced"],
      }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ message: "`url` must use https." })
  })

  it("answers 404 deleting somebody else's endpoint", async () => {
    const missing = createApp({
      apiKeyAuth,
      webhookEndpoints: { ...store, remove: async () => false },
    })
    const res = await missing.request(`/webhook-endpoints/${endpoint.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${KEY}` },
    })
    expect(res.status).toBe(404)
  })

  it("requires a key", async () => {
    expect((await app().request("/webhook-endpoints")).status).toBe(401)
  })

  it("answers 501 when the store is not wired", async () => {
    expect((await get(createApp({ apiKeyAuth }), "/webhook-endpoints")).status).toBe(
      501,
    )
  })
})

describe("POST /webhooks/ses", () => {
  // ⚠ `JSON.parse` SUCCEEDS ON `null`, AND THE VERIFIER READS `.Type` OFF IT.
  // Without the shape guard this is a TypeError before any signature check —
  // a 500 and an error log that any unauthenticated caller can produce at will,
  // in exactly the log an operator watches for real ingest failures.
  it.each([["null"], ["123"], ['"a string"'], ["[]"]])(
    "answers 400 rather than throwing on a body of %s",
    async (body) => {
      const app = createApp({
        sesWebhooks: {
          events: {
            ownerOf: async () => null,
            record: async () => ({ status: "duplicate" as const }),
            enqueue: async () => {},
          },
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
      })

      const res = await app.request("/webhooks/ses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })

      expect(res.status).toBe(400)
    },
  )
})

describe("/internal/queue-depth", () => {
  const depth = {
    pending: { transactional: 3, bulk: 40, webhooks: 1 },
    delayed: { transactional: 0, bulk: 0, webhooks: 0 },
    total: 44,
  }
  const app = () =>
    createApp({
      metrics: { token: "a-metrics-token-long-enough", queueDepth: async () => depth },
    })

  it("answers the autoscaler with a bearer token", async () => {
    const res = await app().request("/internal/queue-depth", {
      headers: { Authorization: "Bearer a-metrics-token-long-enough" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 44 })
  })

  // ⚠ AN UNAUTHENTICATED ENDPOINT THAT TOUCHES REDIS ON EVERY REQUEST IS A FREE
  // AMPLIFIER, and KEDA can send a token, so there is no reason to leave it open.
  it.each([
    ["no header", undefined],
    ["a wrong token", "Bearer nope"],
    ["a prefix of the token", "Bearer a-metrics-token-long-enoug"],
  ])("refuses %s", async (_label, header) => {
    const res = await app().request("/internal/queue-depth", {
      headers: header ? { Authorization: header } : {},
    })
    expect(res.status).toBe(401)
  })

  it("answers 501 when metrics are not configured", async () => {
    const res = await createApp().request("/internal/queue-depth")
    expect(res.status).toBe(501)
  })
})
