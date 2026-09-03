import { describe, expect, it, vi } from "vitest"
import { autumnClient, autumnMetering } from "../src/send/autumn.js"

/**
 * The Autumn client, against a fake `fetch`.
 *
 * The interesting assertions are all about what happens when Autumn does NOT
 * answer cleanly, because those are the paths that decide whether a customer's
 * mail goes out and whether they get billed once or twice.
 */

type Reply = { status: number; body?: unknown } | Error

function client(replies: Reply | Reply[]) {
  const queue = Array.isArray(replies) ? [...replies] : [replies]
  const calls: { url: string; init: RequestInit; body: unknown }[] = []

  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "null")),
    })
    if (reply instanceof Error) throw reply
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    })
  })

  return {
    calls,
    fakeFetch,
    autumn: autumnClient({
      baseUrl: "https://autumn.internal/",
      secretKey: "am_sk_test",
      featureId: "emails",
      fetch: fakeFetch as unknown as typeof fetch,
    }),
  }
}

const header = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string>)[name]

describe("check", () => {
  it("allows when Autumn says so", async () => {
    const { autumn, calls } = client({ status: 200, body: { allowed: true } })

    expect(await autumn.check("ten-1", 3)).toEqual({ status: "allowed" })

    expect(calls[0]?.url).toBe("https://autumn.internal/v1/balances.check")
    expect(calls[0]?.body).toEqual({
      customer_id: "ten-1",
      feature_id: "emails",
      // ⚠ The whole batch in one call, not one call per message.
      required_balance: 3,
    })
    expect(header(calls[0]!.init, "authorization")).toBe("Bearer am_sk_test")
    expect(header(calls[0]!.init, "x-api-version")).toBe("2.3.0")
  })

  it("reports exceeded, with the reset it was told", async () => {
    const resetsAt = Date.UTC(2026, 9, 1)
    const { autumn } = client({
      status: 200,
      body: { allowed: false, balance: { remaining: 0, next_reset_at: resetsAt } },
    })

    const outcome = await autumn.check("ten-1", 1)

    expect(outcome).toMatchObject({ status: "exceeded", resetsAt: new Date(resetsAt) })
  })

  // ⚠ THE ONE THAT KEEPS A BILLING OUTAGE FROM BECOMING AN i10 OUTAGE. Every
  // one of these is "we could not ask", which `shouldSend` turns into a send —
  // never "you are over quota", which a customer answers by upgrading a plan
  // that was already fine.
  it.each([
    ["a network failure", new Error("ECONNREFUSED") as Reply],
    ["a timeout", new Error("TimeoutError") as Reply],
    ["a 500", { status: 500 } as Reply],
    ["a 502 with an HTML body", { status: 502 } as Reply],
    // A tenant that is not a customer at all. A real and serious problem, but
    // not evidence about their quota — `missingCustomers()` is what finds it.
    ["a 404", { status: 404 } as Reply],
  ])("answers unavailable for %s", async (_label, reply) => {
    const { autumn } = client(reply)
    expect((await autumn.check("ten-1", 1)).status).toBe("unavailable")
  })

  it("does not treat an unparseable 200 as permission", async () => {
    const { autumn } = client({ status: 200, body: null })
    expect((await autumn.check("ten-1", 1)).status).toBe("exceeded")
  })
})

describe("batchTrack", () => {
  it("posts a bare array of events", async () => {
    const at = new Date("2026-09-02T23:59:59.900Z")
    const { autumn, calls } = client({ status: 202, body: { success: true } })

    await autumn.batchTrack([
      { customerId: "ten-1", messageId: "msg-a", at },
      { customerId: "ten-1", messageId: "msg-b", at },
    ])

    expect(calls[0]?.url).toBe("https://autumn.internal/v1/balances.batch_track")
    // ⚠ A bare array. Not `{ events: [...] }` — Autumn's schema is `type: array`.
    expect(calls[0]?.body).toEqual([
      {
        customer_id: "ten-1",
        feature_id: "emails",
        value: 1,
        timestamp: at.getTime(),
        properties: { i10_message_id: "msg-a" },
      },
      {
        customer_id: "ten-1",
        feature_id: "emails",
        value: 1,
        timestamp: at.getTime(),
        properties: { i10_message_id: "msg-b" },
      },
    ])
  })

  // ⚠ THE STORED `sent_at`, NOT THE MOMENT WE HAPPEN TO CALL AUTUMN. The
  // reconciler buckets our side by `sent_at` and Autumn's by this value; a
  // millisecond of disagreement across midnight makes one day short and the
  // next long, and the short one is topped up on every run, forever.
  it("bills each message at the timestamp the database stored", async () => {
    const { autumn, calls } = client({ status: 202 })
    const first = new Date("2026-09-02T23:59:59.900Z")
    const second = new Date("2026-09-03T00:00:00.100Z")

    await autumn.batchTrack([
      { customerId: "ten-1", messageId: "a", at: first },
      { customerId: "ten-1", messageId: "b", at: second },
    ])

    const body = calls[0]?.body as { timestamp: number }[]
    expect(body.map((e) => e.timestamp)).toEqual([first.getTime(), second.getTime()])
  })

  // ⚠ NEVER RETRIED — Autumn's own documentation says a retried batch
  // re-enqueues what already succeeded and double-deducts, and that gaps are
  // preferable to duplicates. So it throws exactly once and the caller logs it.
  it("throws rather than retrying a failed batch", async () => {
    const { autumn, fakeFetch } = client({ status: 503 })

    await expect(
      autumn.batchTrack([{ customerId: "ten-1", messageId: "a", at: new Date() }]),
    ).rejects.toThrow(/503/)
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it("splits anything over Autumn's thousand-event limit", async () => {
    const { autumn, calls } = client({ status: 202 })
    const at = new Date()

    await autumn.batchTrack(
      Array.from({ length: 1500 }, (_, i) => ({
        customerId: "ten-1",
        messageId: `m-${i}`,
        at,
      })),
    )

    expect(calls).toHaveLength(2)
    expect((calls[0]?.body as unknown[]).length).toBe(1000)
    expect((calls[1]?.body as unknown[]).length).toBe(500)
  })
})

describe("track", () => {
  // ⚠ THE KEY IS THE MESSAGE ID, WHICH IS THE ONLY REASON THE RECONCILER CAN
  // RUN TWICE. Autumn 409s a replayed key, so the same message cannot be billed
  // a second time however many reconcilers race.
  it("sends the message id as the idempotency key", async () => {
    const { autumn, calls } = client({ status: 200, body: {} })
    await autumn.track({ customerId: "ten-1", messageId: "msg-a", at: new Date() })
    expect(header(calls[0]!.init, "Idempotency-Key")).toBe("msg-a")
  })

  it("reads a 409 as already counted rather than as a failure", async () => {
    const { autumn } = client({ status: 409 })
    await expect(
      autumn.track({ customerId: "ten-1", messageId: "msg-a", at: new Date() }),
    ).resolves.toBe("duplicate")
  })

  it("throws on anything else, so a top-up cannot silently skip", async () => {
    const { autumn } = client({ status: 500 })
    await expect(
      autumn.track({ customerId: "ten-1", messageId: "msg-a", at: new Date() }),
    ).rejects.toThrow(/500/)
  })
})

describe("aggregateByCustomer", () => {
  const period = Date.UTC(2026, 8, 2)

  it("flattens a grouped aggregate into buckets", async () => {
    const { autumn, calls } = client({
      status: 200,
      body: {
        list: [{ period, grouped_values: { emails: { "ten-1": 12, "ten-2": 3 } } }],
      },
    })

    const buckets = await autumn.aggregateByCustomer(
      new Date(period),
      new Date(period + 86_400_000),
    )

    expect(buckets).toEqual([
      { tenantId: "ten-1", periodStart: new Date(period), count: 12 },
      { tenantId: "ten-2", periodStart: new Date(period), count: 3 },
    ])
    expect(calls[0]?.body).toMatchObject({
      feature_id: "emails",
      group_by: "$customer_id",
      bin_size: "day",
      // ⚠ Autumn defaults this to NINE. Left unset, every tenant past the ninth
      // busiest reads as zero and the reconciler bills their whole day again.
      max_groups: 250,
    })
  })

  // ⚠ REFUSES RATHER THAN RETURNING A TRUNCATED ANSWER, because a truncated
  // aggregate is indistinguishable from tenants who sent nothing — and the
  // reconciler answers "sent nothing" with "bill it all again".
  it("throws when the group cap is hit", async () => {
    const grouped = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`ten-${i}`, 1]),
    )
    const { autumn } = client({
      status: 200,
      body: { list: [{ period, grouped_values: { emails: grouped } }] },
    })

    await expect(
      autumn.aggregateByCustomer(new Date(period), new Date(period + 1)),
    ).rejects.toThrow(/truncated/)
  })
})

describe("entitlements", () => {
  // ⚠ THE TWO FLAGS THAT KEEP AUTUMN OUT OF PAYMENTS. Polar is the merchant of
  // record; there is no Stripe account, so a customer created in Stripe is a
  // call that fails on a credential we do not have.
  it("creates a customer outside Stripe, on the free plan", async () => {
    const { autumn, calls } = client({ status: 200, body: {} })

    await autumn.ensureCustomer({
      tenantId: "ten-1",
      name: "Acme",
      email: "billing@acme.test",
    })

    expect(calls[0]?.url).toBe("https://autumn.internal/v1/customers.get_or_create")
    expect(calls[0]?.body).toMatchObject({
      // ⚠ `customer_id`. This assertion said `id` and passed for months, which
      // is precisely how the bug survived: a fake accepts any shape, and only
      // Autumn rejects it — with a 400, on the first real payment.
      customer_id: "ten-1",
      create_in_stripe: false,
      // ⚠ In the SAME call. A separate attach afterwards can fail on its own
      // and leave a customer with no entitlement, which reads as an outage.
      auto_enable_plan_id: "free",
    })
  })

  it("throws when the customer cannot be created", async () => {
    const { autumn } = client({ status: 500 })
    await expect(autumn.ensureCustomer({ tenantId: "ten-1" })).rejects.toThrow(/500/)
  })

  // ⚠ THE STATUS ALONE IS NOT A DIAGNOSIS. A bare "failed with 400" sent us to
  // replay the call by hand against production to learn the field name was
  // wrong; Autumn had said so in the body all along.
  it("carries Autumn's own message into the error", async () => {
    const { autumn } = client({
      status: 400,
      body: {
        code: "invalid_inputs",
        message: "customer_id: must be a string (received undefined)",
      },
    })

    await expect(autumn.ensureCustomer({ tenantId: "ten-1" })).rejects.toThrow(
      /customer_id: must be a string/,
    )
  })

  // ⚠ THE WHOLE DESIGN IN ONE ASSERTION. `no_billing_changes` is what makes
  // this entitlements-only: the plan attaches, nothing is charged, and Autumn
  // never learns Polar exists — which is why it stays upstream and unforked.
  it("attaches a plan without touching billing", async () => {
    const { autumn, calls } = client({ status: 200, body: {} })

    await autumn.grantPlan({ tenantId: "ten-1", planId: "pro" })

    expect(calls[0]?.url).toBe("https://autumn.internal/v1/billing.attach")
    expect(calls[0]?.body).toMatchObject({
      customer_id: "ten-1",
      plan_id: "pro",
      no_billing_changes: true,
      redirect_mode: "never",
    })
  })

  // ⚠ POLAR'S SUBSCRIPTION ID IS THE IDEMPOTENCY KEY. A webhook Polar retries
  // must target the same subscription rather than mint a second one.
  it("passes the payment provider's subscription id through", async () => {
    const { autumn, calls } = client({ status: 200, body: {} })

    await autumn.grantPlan({
      tenantId: "ten-1",
      planId: "pro",
      subscriptionId: "polar_sub_123",
    })

    expect(calls[0]?.body).toMatchObject({ subscription_id: "polar_sub_123" })
  })

  it("omits it entirely when there is none", async () => {
    const { autumn, calls } = client({ status: 200, body: {} })
    await autumn.grantPlan({ tenantId: "ten-1", planId: "free" })
    expect(calls[0]?.body).not.toHaveProperty("subscription_id")
  })

  it("throws when the attach is refused", async () => {
    const { autumn } = client({ status: 422 })
    await expect(
      autumn.grantPlan({ tenantId: "ten-1", planId: "pro" }),
    ).rejects.toThrow(/422/)
  })
})

describe("autumnMetering", () => {
  it("maps a send record onto a batch of events", async () => {
    const at = new Date("2026-09-02T10:00:00Z")
    const fakeFetch = vi.fn(async () => new Response("{}", { status: 202 }))
    const metering = autumnMetering({
      secretKey: "am_sk_test",
      featureId: "emails",
      fetch: fakeFetch as unknown as typeof fetch,
    })

    await metering.recordSent("ten-1", [{ id: "msg-a", sentAt: at }])

    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })
})
