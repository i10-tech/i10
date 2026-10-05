import { describe, expect, it, mock } from "bun:test"
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
  kind: "http" as const,
  url: "https://hooks.example.com/i10",
  events: ["email.bounced" as const],
  description: null,
  enabled: true,
  disabled_reason: null,
  health: "healthy" as const,
  health_changed_at: null,
  poll_cursor: null,
  last_polled_at: null,
  transformation: null,
  created_at: "2026-09-03T10:00:00.000Z",
  signature_scheme: "hmac_sha256" as const,
  rate_limit: null,
  header_names: [],
  filter_domains: null,
  filter_tags: null,
  public_key: null,
  previous_secrets: [],
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
    const lookup = mock(async () => email)
    const app = createApp({ apiKeyAuth, emailLookup: { get: lookup } })
    await get(app, `/emails/${ID}`)
    expect(lookup).toHaveBeenCalledWith("ten-1", ID)
  })

  // ⚠ 404, NOT 403, FOR ANOTHER TENANT'S ID. Row level security returns
  // nothing, and a 403 would confirm the id exists - turning a status endpoint
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
  // for another on the same message, in whatever order the receivers answer -
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
    expect(lastEvent("sent", null, ["teleported"])).toBe("sent")
  })

  // #154: engagement is past delivery, and every failure still outranks it.
  it("ranks an open or a click above delivery", () => {
    expect(lastEvent("sent", null, ["delivered", "opened"])).toBe("opened")
    expect(lastEvent("sent", null, ["delivered", "opened", "clicked"])).toBe("clicked")
  })

  it("lets a bounce or a complaint beat an open on another recipient", () => {
    expect(lastEvent("sent", null, ["opened", "clicked", "bounced"])).toBe("bounced")
    expect(lastEvent("sent", null, ["clicked", "complained"])).toBe("complained")
  })
})

describe("/webhook-event-types (#283)", () => {
  it("lists every event with a JSON Schema and an example", async () => {
    const res = await get(createApp({ apiKeyAuth }), "/webhook-event-types")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        type: string
        version: number
        schema: { type?: string }
        example: object
      }[]
    }
    expect(body.data).toHaveLength(12)
    for (const e of body.data) {
      expect(e.version).toBe(1)
      expect(e.schema.type).toBe("object")
      expect(e.example).toHaveProperty(
        e.type.startsWith("email.") ? "email_id" : "endpoint_id",
      )
    }
  })

  it("requires a key", async () => {
    expect(
      (await createApp({ apiKeyAuth }).request("/webhook-event-types")).status,
    ).toBe(401)
  })
})

describe("/webhook-health-events (#284)", () => {
  const change = {
    object: "webhook_health_event" as const,
    id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc",
    endpoint_id: endpoint.id,
    kind: "failing" as const,
    url: endpoint.url,
    reason: "HTTP 503",
    failing_since: "2026-10-06T10:00:00.000Z",
    created_at: "2026-10-06T10:15:00.000Z",
  }
  const health = mock(async () => ({ data: [change], next_cursor: null }))
  const app = () =>
    createApp({
      apiKeyAuth,
      webhookHistory: {
        list: async () => ({ data: [], next_cursor: null }),
        get: async () => null,
        expunge: async () => "not_found" as const,
        poll: async () => ({ status: "not_found" as const }),
        health,
      },
    })

  it("lists changes for the key's tenant, filtered by endpoint", async () => {
    const res = await get(
      app(),
      `/webhook-health-events?endpoint_id=${endpoint.id}&limit=5`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [change], next_cursor: null })
    expect(health).toHaveBeenCalledWith("ten-1", { endpointId: endpoint.id, limit: 5 })
  })

  it("refuses a malformed cursor before the store", async () => {
    health.mockClear()
    expect((await get(app(), "/webhook-health-events?cursor=nope")).status).toBe(422)
    expect(health).not.toHaveBeenCalled()
  })

  it("requires a key", async () => {
    expect((await app().request("/webhook-health-events")).status).toBe(401)
  })
})

describe("GET /webhook-endpoints/{id}/poll (#301)", () => {
  const event = {
    id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60dd",
    type: "email.delivered" as const,
    created_at: "2026-10-06T10:00:00.000Z",
    sequence: 4,
    data: { email_id: "x" },
  }
  const poll = mock(async (_t: string, id: string, input: { cursor?: number }) =>
    id === endpoint.id
      ? input.cursor === 9
        ? { status: "rejected" as const, reason: "That cursor is ahead." }
        : {
            status: "ok" as const,
            data: [event],
            next_cursor: "4",
            done: true,
            healthChange: null,
          }
      : id === ID
        ? { status: "not_polling" as const }
        : { status: "not_found" as const },
  )
  const app = () =>
    createApp({
      apiKeyAuth,
      webhookHistory: {
        list: async () => ({ data: [], next_cursor: null }),
        get: async () => null,
        expunge: async () => "not_found" as const,
        health: async () => ({ data: [], next_cursor: null }),
        poll,
      },
    })

  it("returns the page, without the internals, and passes the cursor through", async () => {
    const res = await get(
      app(),
      `/webhook-endpoints/${endpoint.id}/poll?cursor=3&limit=10`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [event], next_cursor: "4", done: true })
    expect(poll).toHaveBeenLastCalledWith("ten-1", endpoint.id, {
      cursor: 3,
      limit: 10,
    })
  })

  it("answers 409 for an HTTP endpoint, 404 for an unknown one, 422 for a bad cursor", async () => {
    expect((await get(app(), `/webhook-endpoints/${ID}/poll`)).status).toBe(409)
    expect(
      (await get(app(), "/webhook-endpoints/0199a3f2-b4c1-7f3e-9d2a-000000000000/poll"))
        .status,
    ).toBe(404)
    expect(
      (await get(app(), `/webhook-endpoints/${endpoint.id}/poll?cursor=9`)).status,
    ).toBe(422)
    poll.mockClear()
    expect(
      (await get(app(), `/webhook-endpoints/${endpoint.id}/poll?cursor=-1`)).status,
    ).toBe(422)
    expect(poll).not.toHaveBeenCalled()
  })
})

describe("/webhook-endpoints", () => {
  const store = {
    create: mock(async () => ({
      status: "created" as const,
      endpoint: { ...endpoint, secret: "whsec_abc" },
    })),
    list: mock(async () => [endpoint]),
    remove: mock(async () => true),
    rotateSecret: mock(async () => ({
      status: "rotated" as const,
      endpoint: { ...endpoint, secret: "whsec_new" },
    })),
    revokePreviousSecrets: mock(async () => endpoint),
    get: mock(async (_t: string, id: string) => (id === endpoint.id ? endpoint : null)),
    update: mock(async () => ({ status: "updated" as const, endpoint })),
    stats: mock(async () => ({
      object: "webhook_endpoint_stats" as const,
      endpoint_id: endpoint.id,
      since: "2026-10-04T00:00:00.000Z",
      until: "2026-10-04T02:00:00.000Z",
      bucket: "hour" as const,
      delivered: 9,
      failed: 1,
      pending: 0,
      success_rate: 0.9,
      last_success_at: null,
      failing_since: null,
      attempts: 12,
      failed_attempts: 3,
      p50_ms: 40,
      p95_ms: 120,
      series: [],
      by_event_type: [],
    })),
    testTransformation: mock(
      async (_t: string, _id: string, input: { code?: string }) =>
        input.code === "broken"
          ? { status: "tried" as const, result: { ok: false as const, error: "boom" } }
          : input.code === "offline"
            ? { status: "unavailable" as const, reason: "Try again shortly." }
            : {
                status: "tried" as const,
                result: {
                  ok: true as const,
                  request: {
                    method: "PUT" as const,
                    url: "/i10?x=1",
                    headers: {},
                    body: "{}",
                  },
                },
              },
    ),
    workspaceStats: mock(async () => ({
      object: "webhook_stats" as const,
      since: "2026-10-04T00:00:00.000Z",
      until: "2026-10-04T02:00:00.000Z",
      bucket: "hour" as const,
      delivered: 9,
      failed: 1,
      pending: 0,
      success_rate: 0.9,
      attempts: 12,
      failed_attempts: 3,
      p50_ms: 40,
      p95_ms: 120,
      series: [],
      by_event_type: [],
      by_endpoint: [],
    })),
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
      events: ["email.teleported"],
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

  describe("managing an endpoint (#281)", () => {
    const req = (method: string, path: string, body?: unknown) =>
      app().request(path, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    it("gets one, and 404s for an id it does not hold", async () => {
      expect((await req("GET", `/webhook-endpoints/${endpoint.id}`)).status).toBe(200)
      expect(
        (await req("GET", "/webhook-endpoints/0199a3f2-b4c1-7f3e-9d2a-000000000000"))
          .status,
      ).toBe(404)
    })

    it("updates, and refuses an empty patch or a bad field before the store", async () => {
      store.update.mockClear()
      expect(
        (await req("PATCH", `/webhook-endpoints/${endpoint.id}`, { rate_limit: 5 }))
          .status,
      ).toBe(200)
      expect(store.update).toHaveBeenCalledTimes(1)
      expect((await req("PATCH", `/webhook-endpoints/${endpoint.id}`, {})).status).toBe(
        422,
      )
      expect(
        (await req("PATCH", `/webhook-endpoints/${endpoint.id}`, { rate_limit: 0 }))
          .status,
      ).toBe(422)
      expect(
        (await req("PATCH", `/webhook-endpoints/${endpoint.id}`, { events: [] }))
          .status,
      ).toBe(422)
      expect(store.update).toHaveBeenCalledTimes(1)
    })

    it("pauses and resumes through the same update", async () => {
      store.update.mockClear()
      await req("POST", `/webhook-endpoints/${endpoint.id}/pause`)
      await req("POST", `/webhook-endpoints/${endpoint.id}/resume`)
      expect(store.update.mock.calls.map((c) => (c as unknown[])[2])).toEqual([
        { enabled: false },
        { enabled: true },
      ])
    })

    it("answers stats for a window", async () => {
      const res = await req(
        "GET",
        // Over a week, so the default step is a day.
        `/webhook-endpoints/${endpoint.id}/stats?since=2026-10-04T00:00:00Z&until=2026-10-20T00:00:00Z`,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ delivered: 9, success_rate: 0.9 })
      const [, , window] = store.stats.mock.calls.at(-1) as unknown as [
        string,
        string,
        { since: Date; until: Date; bucket: string },
      ]
      expect(window.since.toISOString()).toBe("2026-10-04T00:00:00.000Z")
      expect(window.bucket).toBe("day")
    })

    it("refuses a backwards window or too many steps before the store", async () => {
      store.stats.mockClear()
      const backwards = await req(
        "GET",
        `/webhook-endpoints/${endpoint.id}/stats?since=2026-10-05T00:00:00Z&until=2026-10-04T00:00:00Z`,
      )
      expect(backwards.status).toBe(422)
      const tooMany = await req(
        "GET",
        `/webhook-endpoints/${endpoint.id}/stats?since=2026-01-01T00:00:00Z&until=2026-10-01T00:00:00Z&bucket=hour`,
      )
      expect(tooMany.status).toBe(422)
      expect(((await tooMany.json()) as { message: string }).message).toContain(
        "at most 200",
      )
      expect(
        (await req("GET", `/webhook-endpoints/${endpoint.id}/stats?bucket=week`))
          .status,
      ).toBe(422)
      expect(store.stats).not.toHaveBeenCalled()
    })

    it("tries a transformation and shows what would be sent, or why not", async () => {
      const ok = await req(
        "POST",
        `/webhook-endpoints/${endpoint.id}/transformation/test`,
        {
          code: "export default (w) => w",
          event_type: "email.bounced",
        },
      )
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ ok: true, request: { method: "PUT" } })
      expect(store.testTransformation).toHaveBeenLastCalledWith("ten-1", endpoint.id, {
        code: "export default (w) => w",
        eventType: "email.bounced",
      })
      const broken = await req(
        "POST",
        `/webhook-endpoints/${endpoint.id}/transformation/test`,
        {
          code: "broken",
        },
      )
      expect(await broken.json()).toEqual({ ok: false, error: "boom" })
      expect(
        (
          await req("POST", `/webhook-endpoints/${endpoint.id}/transformation/test`, {
            code: "offline",
          })
        ).status,
      ).toBe(503)
    })

    it("answers workspace stats", async () => {
      const res = await req("GET", "/webhook-stats?bucket=hour")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ object: "webhook_stats", attempts: 12 })
      expect(store.workspaceStats).toHaveBeenCalledTimes(1)
    })

    it("answers 501 for a test event when sending is not wired", async () => {
      const res = await req("POST", `/webhook-endpoints/${endpoint.id}/test`, {
        event_type: "email.bounced",
      })
      expect(res.status).toBe(501)
    })
  })

  // ⚠ NO DEFAULT FOR THE OLD SECRET (decision 7). A rotation that does not
  // say what happens to it is refused before the store is asked.
  describe("rotating a secret", () => {
    const rotate = (body: unknown) =>
      post(`/webhook-endpoints/${endpoint.id}/rotate-secret`, body)

    it("refuses a rotation that does not choose for the previous secret", async () => {
      store.rotateSecret.mockClear()
      expect((await rotate({})).status).toBe(422)
      expect(store.rotateSecret).not.toHaveBeenCalled()
    })

    it("revokes the previous secret when told to", async () => {
      store.rotateSecret.mockClear()
      const res = await rotate({ previous_secret: "revoke" })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ secret: "whsec_new" })
      expect(store.rotateSecret.mock.calls[0]).toEqual([
        expect.any(String),
        endpoint.id,
        { action: "revoke" },
        undefined,
      ] as never)
    })

    it("keeps the previous secret for the chosen time", async () => {
      store.rotateSecret.mockClear()
      const res = await rotate({
        previous_secret: "expire",
        expires_in: 3600,
        signature_scheme: "ed25519",
      })
      expect(res.status).toBe(200)
      expect(store.rotateSecret.mock.calls[0]).toEqual([
        expect.any(String),
        endpoint.id,
        { action: "expire", expiresInSeconds: 3600 },
        "ed25519",
      ] as never)
    })

    it.each([
      [{ previous_secret: "expire" }, "expire without a period"],
      [{ previous_secret: "revoke", expires_in: 60 }, "revoke with a period"],
      [{ previous_secret: "expire", expires_in: 59 }, "under a minute"],
      [{ previous_secret: "expire", expires_in: 72 * 3600 + 1 }, "over 72 hours"],
      [{ previous_secret: "keep" }, "an unknown choice"],
    ])("refuses %j (%s)", async (body) => {
      expect((await rotate(body)).status).toBe(422)
    })

    it("surfaces the store's refusal, such as too many live keys", async () => {
      const full = createApp({
        apiKeyAuth,
        webhookEndpoints: {
          ...store,
          rotateSecret: async () => ({
            status: "rejected" as const,
            reason: "At most 3 signing secrets",
          }),
        },
      })
      const res = await full.request(
        `/webhook-endpoints/${endpoint.id}/rotate-secret`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${KEY}`,
          },
          body: JSON.stringify({ previous_secret: "expire", expires_in: 3600 }),
        },
      )
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ message: "At most 3 signing secrets" })
    })

    it("revokes previous secrets on request", async () => {
      const res = await post(
        `/webhook-endpoints/${endpoint.id}/revoke-previous-secrets`,
        {},
      )
      expect(res.status).toBe(200)
      expect(store.revokePreviousSecrets).toHaveBeenCalled()
    })
  })

  it("answers 501 when the store is not wired", async () => {
    expect((await get(createApp({ apiKeyAuth }), "/webhook-endpoints")).status).toBe(
      501,
    )
  })
})

describe("POST /webhooks/ses", () => {
  // ⚠ `JSON.parse` SUCCEEDS ON `null`, AND THE VERIFIER READS `.Type` OFF IT.
  // Without the shape guard this is a TypeError before any signature check -
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
          log: { info: mock(), warn: mock(), error: mock() },
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
