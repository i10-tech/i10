import { describe, expect, test } from "bun:test"
import { broadcastsShape } from "@/lib/shapes/broadcasts"
import { domainsShape } from "@/lib/shapes/domains"
import { featureKind, usageShape } from "@/lib/shapes/usage"
import { webhooksShape } from "@/lib/shapes/webhooks"
import type { FeatureUsage } from "@/lib/types"

/** The first visit's counts (GET /console/shapes) carry what the skeleton reserves. */
describe("first-visit counts that stop a skeleton jumping (2026-11-09)", () => {
  test("webhooks reserve the banner the attention counts say is there", () => {
    const banner = (extra: Record<string, number>) =>
      webhooksShape.fromCounts!({ webhooks: 3, ...extra })!.banner
    expect(banner({ webhooksDisabled: 1 })).toBe("disabled")
    expect(banner({ webhooksFailing: 2 })).toBe("failing")
    expect(banner({ webhooksDisabled: 1, webhooksFailing: 1 })).toBe("both")
    expect(banner({ webhooksDisabled: 0, webhooksFailing: 0 })).toBe("none")
  })

  test("an API that sends no attention counts draws no banner, as before", () => {
    expect(webhooksShape.fromCounts!({ webhooks: 3 })!.banner).toBe("none")
    expect(webhooksShape.fromCounts!({})).toBeNull()
  })

  test("domains and broadcasts show the status filter from two or more statuses", () => {
    expect(
      domainsShape.fromCounts!({ domains: 3, domainStatuses: 2 })!.statusFilter,
    ).toBe(true)
    expect(
      domainsShape.fromCounts!({ domains: 3, domainStatuses: 1 })!.statusFilter,
    ).toBe(false)
    expect(domainsShape.fromCounts!({ domains: 3 })!.statusFilter).toBe(false)
    expect(
      broadcastsShape.fromCounts!({ broadcasts: 2, broadcastStatuses: 2 })!
        .statusFilter,
    ).toBe(true)
    expect(
      broadcastsShape.fromCounts!({ broadcasts: 2, broadcastStatuses: 1 })!
        .statusFilter,
    ).toBe(false)
    expect(broadcastsShape.fromCounts!({ broadcasts: 2 })!.statusFilter).toBe(false)
  })
})

describe("usageShape remembers each feature's layout", () => {
  const feature = (over: Partial<FeatureUsage>): FeatureUsage => ({
    feature_id: "domains",
    label: "Sending domains",
    unit: "",
    used: 1,
    allowance: 3,
    remaining: 2,
    resets_at: null,
    overage: false,
    status: "ok",
    ...over,
  })

  test("featureKind follows FeatureRow's branches", () => {
    expect(featureKind(feature({}))).toBe("meter")
    expect(featureKind(feature({ allowance: 0 }))).toBe("line")
    expect(featureKind(feature({ allowance: null }))).toBe("line")
    expect(featureKind(feature({ status: "unreadable" }))).toBe("note")
    expect(featureKind(feature({ status: "unentitled" }))).toBe("note")
  })

  test("the shape holds one kind per feature, emails left out", () => {
    const shape = usageShape.of({
      usage: [
        feature({ feature_id: "emails" }),
        feature({}),
        feature({ feature_id: "mailboxes", allowance: 0 }),
      ],
      limits: [],
      members: null,
    } as never)
    expect(shape.featureKinds).toEqual(["meter", "line"])
    expect(shape.members).toBe(false)
  })

  test("a shape remembered before layouts were kept still reads", () => {
    expect(usageShape.parse({ limits: 2, members: true, features: 2 })).toEqual({
      limits: 2,
      members: true,
      featureKinds: ["meter", "line"],
    })
  })

  test("a malformed layout list drops the shape", () => {
    expect(usageShape.parse({ limits: 2, members: true, featureKinds: ["huge"] })).toBe(
      null,
    )
    expect(usageShape.parse({ limits: 2, members: true })).toBeNull()
  })

  test("a missing members key is not a members meter", () => {
    expect(usageShape.of({ usage: [], limits: [] } as never).members).toBe(false)
  })
})
