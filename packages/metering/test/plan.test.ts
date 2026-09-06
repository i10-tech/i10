import { describe, expect, it } from "vitest"
import { entitlementFor } from "../src/plan.js"
import type { ConsumableEntitlement, Plan } from "../src/plan.js"

/** Every consumable in this file is a plain, non-overage one unless it says so. */
const consumable = (
  e: Omit<ConsumableEntitlement, "kind" | "overage"> &
    Partial<Pick<ConsumableEntitlement, "overage">>,
): ConsumableEntitlement => ({ kind: "consumable", overage: "never", ...e })

const free: Plan = {
  id: "free",
  source: "catalog",
  entitlements: [consumable({ featureId: "emails", allowance: 100, interval: "day" })],
}

describe("resolving an entitlement", () => {
  it("finds what the plan grants for a feature", () => {
    expect(entitlementFor(free, "emails")).toEqual({
      kind: "consumable",
      overage: "never",
      featureId: "emails",
      allowance: 100,
      interval: "day",
    })
  })

  /**
   * ⚠ `undefined`, NOT AN ALLOWANCE OF ZERO. A feature the plan says nothing
   * about is a misconfiguration — a renamed id, a half-written custom plan — and
   * collapsing it into "exhausted" tells a customer who has sent nothing that
   * they are over quota. Autumn's own config file carries this warning.
   */
  it("returns undefined for a feature the plan does not mention", () => {
    expect(entitlementFor(free, "sms")).toBeUndefined()
  })

  it("carries an unlimited allowance through", () => {
    const enterprise: Plan = {
      id: "acme-2026",
      source: "custom",
      entitlements: [
        consumable({ featureId: "emails", allowance: "unlimited", interval: "month" }),
      ],
    }
    expect(entitlementFor(enterprise, "emails")?.allowance).toBe("unlimited")
  })
})

describe("refusals", () => {
  /**
   * ⚠ AMBIGUOUS RATHER THAN FIRST-WINS. Taking the first would make the answer
   * depend on the order Postgres returned the rows, so the same plan grants 100
   * on one request and 50,000 on the next. A custom plan built through the
   * dashboard is exactly where this arises.
   */
  it("refuses a plan with two entitlements for one feature", () => {
    const broken: Plan = {
      id: "broken",
      source: "custom",
      entitlements: [
        consumable({ featureId: "emails", allowance: 100, interval: "day" }),
        consumable({ featureId: "emails", allowance: 50_000, interval: "month" }),
      ],
    }
    expect(() => entitlementFor(broken, "emails")).toThrow(RangeError)
  })
})
