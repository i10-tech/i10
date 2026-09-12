import { createHmac } from "node:crypto"
import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import { decide, type PolarEvent } from "../src/billing/events.js"

// Fixed so the file does not start failing on the day `current_period_end`
// below goes past — entitlement genuinely depends on the clock now.
const NOW = new Date("2026-09-03T12:00:00Z")

const options = {
  planForProduct: (id: string) => (id === "prod_pro" ? "pro" : undefined),
  freePlanId: "free",
  now: () => NOW,
}

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  product_id: "prod_pro",
  customer_id: "cus_1",
  customer: { external_id: "ten-1" },
  current_period_end: "2026-10-03T00:00:00Z",
  cancel_at_period_end: false,
  modified_at: "2026-09-03T12:00:00Z",
  created_at: "2026-09-01T12:00:00Z",
  ...over,
})

const event = (over: Record<string, unknown> = {}, type = "subscription.active") =>
  ({ type, data: subscription(over) }) as unknown as PolarEvent

describe("deciding what a Polar event means", () => {
  it("entitles an active subscription to the plan it bought", () => {
    const decided = decide(event(), options)
    expect(decided).toMatchObject({
      kind: "apply",
      state: { tenantId: "ten-1", planId: "pro", entitledPlanId: "pro" },
    })
  })

  // ⚠ `canceled` IS NOT `revoked`. Cancelling sets a flag and keeps the
  // subscription active until the period ends; downgrading here takes away
  // access somebody has already paid for.
  it("keeps the plan when a customer has cancelled but the period has not ended", () => {
    const decided = decide(
      event({ cancel_at_period_end: true }, "subscription.canceled"),
      options,
    )
    expect(decided).toMatchObject({
      kind: "apply",
      state: { entitledPlanId: "pro", cancelAtPeriodEnd: true },
    })
  })

  // ⚠ THE END DATE IS THE END DATE, WITH OR WITHOUT THE EVENT THAT ANNOUNCES
  // IT. Polar sends `subscription.revoked` when the period runs out, and this
  // is what happens if that event is lost: the status still reads `active`
  // because nothing has updated it, and the entitlement ends anyway. Without
  // this the customer keeps Pro until somebody notices by hand.
  it("drops to the free plan once a cancelled subscription's period has passed", () => {
    const decided = decide(
      event({
        cancel_at_period_end: true,
        current_period_end: "2026-09-03T11:59:59Z",
      }),
      options,
    )
    expect(decided).toMatchObject({
      kind: "apply",
      state: { status: "active", planId: "pro", entitledPlanId: "free" },
    })
  })

  // The boundary matters because there is no grace period on either side of
  // it: a second earlier is the plan they paid for, and the instant itself is
  // not.
  it("keeps the plan until the last moment of a cancelled period", () => {
    const upTo = (current_period_end: string) =>
      decide(event({ cancel_at_period_end: true, current_period_end }), options)

    expect(upTo("2026-09-03T12:00:00.001Z")).toMatchObject({
      state: { entitledPlanId: "pro" },
    })
    expect(upTo("2026-09-03T12:00:00.000Z")).toMatchObject({
      state: { entitledPlanId: "free" },
    })
  })

  // ⚠ A RENEWING SUBSCRIPTION IS BRIEFLY PAST ITS OWN PERIOD END, EVERY CYCLE.
  // Expiring on the date alone would cut off a paying customer once a month
  // for as long as Polar takes to push the renewal through.
  it("keeps a renewing subscription whose period end has gone by", () => {
    const decided = decide(
      event({
        cancel_at_period_end: false,
        current_period_end: "2026-09-03T11:59:59Z",
      }),
      options,
    )
    expect(decided).toMatchObject({ state: { entitledPlanId: "pro" } })
  })

  it("does not expire a cancelled subscription with no stated period end", () => {
    const decided = decide(
      event({ cancel_at_period_end: true, current_period_end: null }),
      options,
    )
    expect(decided).toMatchObject({ state: { entitledPlanId: "pro" } })
  })

  it("drops to the free plan once the subscription is revoked", () => {
    const decided = decide(
      event({ status: "canceled" }, "subscription.revoked"),
      options,
    )
    expect(decided).toMatchObject({ kind: "apply", state: { entitledPlanId: "free" } })
  })

  // A failed card is not a customer who stopped paying. Polar retries for days.
  it("keeps the plan while a payment is past due", () => {
    const decided = decide(
      event({ status: "past_due" }, "subscription.past_due"),
      options,
    )
    expect(decided).toMatchObject({ kind: "apply", state: { entitledPlanId: "pro" } })
  })

  it("entitles a trial", () => {
    const decided = decide(event({ status: "trialing" }), options)
    expect(decided).toMatchObject({ kind: "apply", state: { entitledPlanId: "pro" } })
  })

  // ⚠ `subscription.created` IS NOT PROOF OF PAYMENT. The decision is made from
  // the status, so an incomplete one grants nothing whatever its event is called.
  it("grants nothing for a subscription that has not completed payment", () => {
    const decided = decide(
      event({ status: "incomplete" }, "subscription.created"),
      options,
    )
    expect(decided).toMatchObject({ kind: "apply", state: { entitledPlanId: "free" } })
  })

  it("ignores an event with no external customer id", () => {
    const decided = decide(event({ customer: { external_id: null } }), options)
    expect(decided).toMatchObject({ kind: "ignore" })
  })

  it("ignores a product that is not an i10 plan", () => {
    const decided = decide(event({ product_id: "prod_other" }), options)
    expect(decided).toMatchObject({ kind: "ignore" })
  })

  it("ignores orders, checkouts and everything else", () => {
    for (const type of ["order.paid", "checkout.created", "benefit_grant.created"]) {
      expect(decide(event({}, type), options)).toMatchObject({ kind: "ignore" })
    }
  })

  // The ordering key. Using our own clock would make two deliveries that arrive
  // together unorderable, which is exactly when ordering matters.
  it("takes its ordering from Polar's clock, falling back to created_at", () => {
    expect(decide(event(), options)).toMatchObject({
      state: { eventAt: new Date("2026-09-03T12:00:00Z") },
    })
    expect(decide(event({ modified_at: null }), options)).toMatchObject({
      state: { eventAt: new Date("2026-09-01T12:00:00Z") },
    })
  })
})

const SECRET = "whsec_test"
const sign = (body: string, id: string, ts: string) =>
  `v1,${createHmac("sha256", Buffer.from(SECRET, "utf8"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64")}`

const post = (app: ReturnType<typeof createApp>, body: string, signature?: string) => {
  const ts = String(Math.floor(Date.now() / 1000))
  return app.request("/webhooks/polar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": signature ?? sign(body, "msg_1", ts),
    },
    body,
  })
}

const log = { info: () => {}, warn: () => {}, error: () => {} }

describe("POST /webhooks/polar", () => {
  it("applies a verified subscription event", async () => {
    const apply = mock(async () => ({ status: "applied" as const, planId: "pro" }))
    const app = createApp({
      polarWebhooks: { secret: SECRET, grants: { apply }, options, log },
    })

    const body = JSON.stringify(event())
    const res = await post(app, body)

    expect(res.status).toBe(202)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "ten-1", entitledPlanId: "pro" }),
    )
  })

  // ⚠ THE ONE TEST THIS FILE EXISTS FOR. An unverified request must not reach
  // the grant path — a forged `subscription.active` is a free Pro account.
  it("grants nothing when the signature does not verify", async () => {
    const apply = mock()
    const app = createApp({
      polarWebhooks: { secret: SECRET, grants: { apply }, options, log },
    })

    const res = await post(app, JSON.stringify(event()), "v1,AAAA")

    expect(res.status).toBe(403)
    expect(apply).not.toHaveBeenCalled()
  })

  it("answers 202 to a verified event that is not ours, so Polar stops retrying", async () => {
    const apply = mock()
    const app = createApp({
      polarWebhooks: { secret: SECRET, grants: { apply }, options, log },
    })

    const res = await post(app, JSON.stringify(event({}, "order.paid")))

    expect(res.status).toBe(202)
    expect(apply).not.toHaveBeenCalled()
  })

  // ⚠ 500 SO POLAR RETRIES. The row is already durable, so the retry re-runs
  // the Autumn call rather than starting over.
  it("answers 500 when the entitlement could not be applied", async () => {
    const app = createApp({
      polarWebhooks: {
        secret: SECRET,
        grants: {
          apply: async () => {
            throw new Error("autumn is down")
          },
        },
        options,
        log,
      },
    })

    const res = await post(app, JSON.stringify(event()))
    expect(res.status).toBe(500)
  })

  it("answers 503 rather than 404 when billing events are not configured", async () => {
    const res = await post(createApp(), JSON.stringify(event()))
    expect(res.status).toBe(503)
  })

  it("does not 500 on a signed body that is not an object", async () => {
    const app = createApp({
      polarWebhooks: { secret: SECRET, grants: { apply: mock() }, options, log },
    })
    const res = await post(app, "null")
    expect(res.status).toBe(202)
  })
})
