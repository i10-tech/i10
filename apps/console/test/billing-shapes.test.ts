import { describe, expect, test } from "bun:test"
import { mergeShapes, shapeFromText } from "@/lib/shapes"
import { billingCounts, billingShape, cardNote } from "@/lib/shapes/billing"
import type { BillingState, PlanSummary } from "@/lib/types"
import { renderLoading } from "./parity/harness"

const { BillingView } = await import("@/components/billing-view")
const view = {
  route: "/settings/billing",
  pathname: "/settings/billing",
  View: BillingView,
  shape: billingShape,
  cases: [],
} as never

const plan = (id: string, rank: number, entitlements = 5): PlanSummary => ({
  id,
  name: id,
  rank,
  source: "catalog",
  entitlements: Array.from({ length: entitlements }, (_, i) => ({
    featureId: `f${i}`,
    kind: "metered",
    allowance: 1,
  })),
})

const PLANS = [plan("free", 0, 5), plan("starter", 1, 5), plan("pro", 2, 5)]

const billing = (over: Partial<BillingState> = {}): BillingState => ({
  plan: PLANS[2]!,
  subscription: {
    status: "active",
    plan_id: "pro",
    cancel_at_period_end: false,
    current_period_end: "2026-12-01T00:00:00.000Z",
    scheduled_plan_id: null,
    scheduled_at: null,
    polar_customer_id: "cus_1",
  },
  anchor: null,
  overage_enabled: false,
  storage_bytes: null,
  ...over,
})

describe("billingShape first visit", () => {
  test("a Pro workspace is drawn as one, from /console/me and the catalogue", () => {
    const counts = { ...billingCounts(billing()), plans: 3, planEntitlements: 5 }
    expect(billingShape.fromCounts?.(counts)).toEqual({
      plan: true,
      custom: false,
      subscription: "active",
      checkout: false,
      plans: 3,
      entitlements: 5,
      note: null,
    })
  })

  test("a free workspace is none, so its own copy is right", () => {
    const counts = { ...billingCounts(billing({ subscription: null })), plans: 3 }
    expect(billingShape.fromCounts?.(counts)).toMatchObject({ subscription: "none" })
  })

  test("a scheduled change is told apart from an active one", () => {
    const scheduled = billing({
      subscription: { ...billing().subscription!, scheduled_plan_id: "starter" },
    })
    expect(billingCounts(scheduled).billingSubscription).toBe(2)
  })

  test("a custom plan keeps its badge", () => {
    const custom = billing({ plan: { ...PLANS[2]!, source: "custom" } })
    expect(
      billingShape.fromCounts?.({ ...billingCounts(custom), plans: 3 }),
    ).toMatchObject({ custom: true })
  })

  test("the card with a note comes from the API's counts", () => {
    expect(
      billingShape.fromCounts?.({
        ...billingCounts(billing()),
        plans: 3,
        planNoteCard: 1,
        planNoteLines: 3,
      }),
    ).toMatchObject({ note: { card: 1, lines: 3 } })
  })

  test("with nothing known, the subscription is unknown, never none", () => {
    expect(billingShape.fromCounts?.({ plans: 3 })).toMatchObject({
      subscription: "unknown",
      plans: 3,
      entitlements: null,
    })
    expect(billingShape.fromCounts?.({ domains: 2 })).toBeNull()
    expect(shapeFromText(billingShape, undefined).subscription).toBe("unknown")
  })

  test("a remembered cookie wins over the counts", () => {
    const cookie = JSON.stringify({
      plan: true,
      custom: false,
      subscription: "none",
      checkout: false,
      plans: 3,
      entitlements: 5,
      note: null,
    })
    const merged = mergeShapes({ billing: cookie }, billingCounts(billing()), [
      billingShape,
    ])
    expect(merged.billing).toBe(cookie)
  })
})

describe("billingShape remembered value", () => {
  test("a loaded page remembers the longest card and the note's card", () => {
    const scheduled = billing({
      subscription: { ...billing().subscription!, scheduled_plan_id: "starter" },
    })
    const shape = billingShape.of({
      billing: scheduled,
      plans: [plan("free", 0, 4), plan("starter", 1, 5), plan("pro", 2, 3)],
      checkoutId: null,
      scheduledName: "starter",
    })
    expect(shape).toMatchObject({
      subscription: "scheduled",
      plans: 3,
      entitlements: 5,
      note: { card: 1, lines: 3 },
    })
    expect(billingShape.parse(JSON.parse(JSON.stringify(shape)))).toEqual(shape)
  })

  test("an old cookie, written before entitlements and note, still parses", () => {
    expect(
      billingShape.parse({
        plan: true,
        custom: false,
        subscription: "active",
        checkout: false,
        plans: 3,
      }),
    ).toEqual({
      plan: true,
      custom: false,
      subscription: "active",
      checkout: false,
      plans: 3,
      entitlements: null,
      note: null,
    })
  })

  test("garbage drops to the fallback", () => {
    expect(billingShape.parse({ subscription: "paid", plans: 3 })).toBeNull()
    expect(
      billingShape.parse({ subscription: "none", plans: 3, entitlements: -1 }),
    ).toBeNull()
    expect(billingShape.parse({ subscription: "none", plans: "3" })).toBeNull()
  })
})

describe("cardNote", () => {
  test("a scheduled move puts the note on the scheduled plan's card", () => {
    const b = billing({
      subscription: { ...billing().subscription!, scheduled_plan_id: "starter" },
    })
    expect(cardNote(b, PLANS)).toEqual({ card: 1, lines: 3 })
  })

  test("an ending subscription puts it on the free card", () => {
    const b = billing({
      subscription: { ...billing().subscription!, cancel_at_period_end: true },
    })
    expect(cardNote(b, PLANS)).toEqual({ card: 0, lines: 2 })
  })

  test("an ending subscription with no date says nothing yet", () => {
    const b = billing({
      subscription: {
        ...billing().subscription!,
        cancel_at_period_end: true,
        current_period_end: null,
      },
    })
    expect(cardNote(b, PLANS)).toBeNull()
  })

  test("nothing pending, or a plan not in the catalogue, is no note", () => {
    expect(cardNote(billing(), PLANS)).toBeNull()
    expect(cardNote(billing({ subscription: null }), PLANS)).toBeNull()
    const b = billing({
      subscription: { ...billing().subscription!, scheduled_plan_id: "gone" },
    })
    expect(cardNote(b, PLANS)).toBeNull()
  })
})

describe("the billing skeleton", () => {
  const known = {
    ...billingShape.fallback,
    subscription: "active" as const,
    plans: 3,
    entitlements: 5,
  }

  test("an unknown subscription draws bars, never the free plan's sentence", () => {
    const html = renderLoading(view, billingShape.fallback)
    expect(html).not.toContain("No paid subscription")
    expect(html).not.toContain("No card on file")
  })

  test("a known free workspace keeps its own words", () => {
    const html = renderLoading(view, { ...known, subscription: "none" })
    expect(html).toContain("No paid subscription")
  })

  test("each card draws as many entitlement rows as the longest one", () => {
    const html = renderLoading(view, known)
    expect(html.match(/<span style="height:20\.8px">/g)?.length).toBe(15)
  })

  test("only the note's card reserves the note's room", () => {
    const html = renderLoading(view, { ...known, note: { card: 1, lines: 3 } })
    expect(html).toContain('data-bone="billing/plan-1/note"')
    expect(html).not.toContain('data-bone="billing/plan-0/note"')
    expect(renderLoading(view, known)).not.toContain("/note")
  })
})
