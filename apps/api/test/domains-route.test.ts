import { describe, expect, it } from "bun:test"
import {
  resolveRoute,
  type DeliveryRoute,
  type RouteOverride,
} from "../src/domains/route.js"

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

describe("reading the kill switch out of the environment", () => {
  /**
   * ⚠ THE REGRESSION: `SES_ENABLED=0` USED TO MEAN ENABLED. The parser was
   * `raw !== "false"`, so every conventional falsy spelling silently left SES
   * on — on the one switch whose entire job is to be thrown mid-incident.
   */
  it("accepts the spellings an operator actually types", async () => {
    const { parseSesEnabled } = await import("../src/env.js")
    for (const on of ["true", "1", "yes", "on", "TRUE", " on ", undefined]) {
      expect(parseSesEnabled(on)).toBe(true)
    }
    for (const off of ["false", "0", "no", "off", "OFF", " 0 "]) {
      expect(parseSesEnabled(off)).toBe(false)
    }
  })

  // ⚠ AND REFUSES ANYTHING ELSE RATHER THAN PICKING A SIDE.
  it("throws on a value it cannot interpret", async () => {
    const { parseSesEnabled } = await import("../src/env.js")
    expect(() => parseSesEnabled("maybe")).toThrow(/SES_ENABLED/)
  })
})

/**
 * ⚠ THE SAME RULE EXISTS TWICE, AND THIS IS THE ONLY THING HOLDING THE TWO
 * TOGETHER. `resolveRoute` decides the TRANSACTIONAL route in TypeScript, where
 * our worker owns the message. `core.resolve_route` decides the MAILBOX route in
 * Postgres, because mailbox mail is submitted straight into Stalwart's queue by a
 * person's mail client and no code of ours is in that path — the only way to ask
 * us is a query.
 *
 * Two implementations of one rule drift, and the drift is silent: the dashboard
 * renders `ses` while the mail goes direct, and nobody finds out until somebody
 * compares them by hand. So the table below is asserted here against the
 * TypeScript and, character for character, inside `0036_mailbox_lever.sql`
 * against the SQL — same order, same values, so the two read side by side in a
 * diff. The migration's `ASSERT`s run on deploy, which means a wrong SQL rule
 * fails the deploy rather than misrouting mail.
 *
 * ⚠ IF YOU ADD A CASE HERE, ADD IT THERE.
 */
describe("the rule, mirrored in SQL", () => {
  // ⚠ THE LAST COLUMN IS THE `DeliveryRoute` UNION, NOT `string`. bun types a
  // matcher against the value it received, so a widened `string` here stops the
  // expectation being checked against the real return type — and a typo in an
  // expected value becomes a failing assertion instead of a compile error.
  const cases: [string, RouteOverride, string | null, boolean, DeliveryRoute][] = [
    // The kill switch beats everything, including an explicit override.
    ["kill switch beats auto", "auto", "pro", false, "direct"],
    ["kill switch beats an ses override", "ses", "pro", false, "direct"],
    ["kill switch agrees with a direct override", "direct", "pro", false, "direct"],

    // An override beats the plan, in both directions.
    ["ses override beats a free plan", "ses", "free", true, "ses"],
    ["direct override beats a paid plan", "direct", "pro", true, "direct"],

    // Otherwise the plan decides.
    ["a paid plan sends through ses", "auto", "pro", true, "ses"],
    ["a free plan sends direct", "auto", "free", true, "direct"],

    // No plan, and a plan id nobody recognises.
    ["no plan at all sends direct", "auto", null, true, "direct"],
    // ⚠ THIS CASE CONTRADICTS THE COMMENT ABOVE `resolveRoute`, AND IT IS
    // PINNED HERE RATHER THAN QUIETLY CORRECTED. That comment says "free is the
    // DEFAULT, not the exception: anything we do not recognise as a paid plan
    // lands here [direct]", and warns that otherwise "a plan id renamed in the
    // catalogue would start spending SES money on free tenants".
    //
    // The code does the opposite: it recognises FREE by name and treats
    // everything else as paid. So renaming the free plan in the catalogue
    // without moving `METERING_FREE_PLAN_ID` puts every free tenant on SES —
    // exactly the outcome the comment says it prevents.
    //
    // This is asserted as-is because the mailbox lever's SQL must mirror the
    // CODE, not the comment, or the two levers disagree. Whether the rule itself
    // should change is a pricing decision, not a refactor.
    [
      "an unrecognised plan id is treated as paid",
      "auto",
      "renamed-in-the-catalogue",
      true,
      "ses",
    ],
  ]

  for (const [name, override, planId, sesEnabled, expected] of cases) {
    it(name, () => {
      expect(resolveRoute({ override, planId, freePlanId: "free", sesEnabled })).toBe(
        expected,
      )
    })
  }
})
