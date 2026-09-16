import { describe, expect, it } from "bun:test"
import { resolveRoute } from "../src/domains/route.js"

/**
 * Which MTA a domain's mail leaves through. Stalwart enforces this per
 * recipient by evaluating its own expression; this is the same rule where our
 * code can read it, and the two must never be able to disagree.
 */
const route = (over: Partial<Parameters<typeof resolveRoute>[0]> = {}) =>
  resolveRoute({
    override: "auto",
    planId: "pro",
    freePlanId: "free",
    sesEnabled: true,
    ...over,
  })

describe("what the plan decides", () => {
  it("sends free through our own MTA", () => {
    expect(route({ planId: "free" })).toBe("direct")
  })

  it("sends paid through SES", () => {
    expect(route({ planId: "pro" })).toBe("ses")
  })

  /**
   * ⚠ FREE IS THE DEFAULT, NOT THE EXCEPTION. A plan id renamed in the
   * catalogue would otherwise start spending SES money on tenants who pay
   * nothing — silently, and in the direction nobody reports.
   */
  it("treats a tenant with no plan as free", () => {
    expect(route({ planId: null })).toBe("direct")
  })
})

describe("the override", () => {
  /**
   * ⚠ IT BEATS THE PLAN, INCLUDING FOR A PAYING CUSTOMER. That is the reason it
   * exists: somebody moved off a route that is having a bad day must not be
   * moved back by their own subscription.
   */
  it("wins over the plan in both directions", () => {
    expect(route({ override: "direct", planId: "pro" })).toBe("direct")
    expect(route({ override: "ses", planId: "free" })).toBe("ses")
  })

  // ⚠ `auto` is not a third MTA — it is "ask the plan". Something must send.
  it("resolves auto to a real route", () => {
    expect(["ses", "direct"]).toContain(route({ override: "auto" }))
  })
})

describe("the operator kill switch", () => {
  /**
   * ⚠ IT BEATS THE OVERRIDE, WHICH BEATS EVERYTHING ELSE. The switch is thrown
   * during an incident, so the one thing it must not do is leave the domains
   * somebody deliberately pinned to SES still pointed at SES.
   */
  it("routes everything direct, over any plan and any override", () => {
    expect(route({ sesEnabled: false, planId: "pro" })).toBe("direct")
    expect(route({ sesEnabled: false, override: "ses", planId: "pro" })).toBe("direct")
    expect(route({ sesEnabled: false, override: "direct" })).toBe("direct")
  })

  // The ordinary state, stated so a regression in the default is visible here
  // rather than only in production.
  it("changes nothing while SES is enabled", () => {
    expect(route({ sesEnabled: true, planId: "pro" })).toBe("ses")
    expect(route({ sesEnabled: true, planId: "free" })).toBe("direct")
  })
})
