import { describe, expect, it } from "bun:test"
import {
  resolveMailboxRoute,
  resolveRoute,
  type DeliveryRoute,
  type RouteOverride,
} from "../src/domains/route.js"

/**
 * Which MTA a domain's mail leaves through. The transactional rule is ours
 * alone; the mailbox rule is also evaluated by Stalwart, through
 * `core.resolve_route`, and the two must never be able to disagree.
 */
const route = (over: Partial<Parameters<typeof resolveRoute>[0]> = {}) =>
  resolveRoute({ override: "auto", sesEnabled: true, ...over })

const mailboxRoute = (over: Partial<Parameters<typeof resolveMailboxRoute>[0]> = {}) =>
  resolveMailboxRoute({
    override: "auto",
    planId: "pro",
    freePlanId: "free",
    sesEnabled: true,
    ...over,
  })

describe("transactional mail", () => {
  /**
   * ⚠ #155: EVERY PLAN GOES THROUGH SES, FREE INCLUDED. The plan is not even an
   * input — a free sender direct would sit on the IP our human mailboxes share,
   * outside SES's per-tenant reputation, suppression and pause controls.
   */
  it("sends through SES by default", () => {
    expect(route()).toBe("ses")
  })

  it("lets an override move one domain off SES, or pin it there", () => {
    expect(route({ override: "direct" })).toBe("direct")
    expect(route({ override: "ses" })).toBe("ses")
  })

  /**
   * ⚠ THE KILL SWITCH BEATS THE OVERRIDE, WHICH BEATS EVERYTHING ELSE. The
   * switch is thrown during an incident, so the one thing it must not do is
   * leave the domains somebody deliberately pinned to SES still pointed at SES.
   */
  it("routes everything direct while SES is switched off", () => {
    expect(route({ sesEnabled: false })).toBe("direct")
    expect(route({ sesEnabled: false, override: "ses" })).toBe("direct")
    expect(route({ sesEnabled: false, override: "direct" })).toBe("direct")
  })
})

describe("mailbox mail", () => {
  // Still decided by plan until the ses-relay route exists (#191).
  it("sends free direct and paid through SES", () => {
    expect(mailboxRoute({ planId: "free" })).toBe("direct")
    expect(mailboxRoute({ planId: "pro" })).toBe("ses")
  })

  it("treats a tenant with no plan as free", () => {
    expect(mailboxRoute({ planId: null })).toBe("direct")
  })

  /**
   * ⚠ IT BEATS THE PLAN, INCLUDING FOR A PAYING CUSTOMER. Somebody moved off a
   * route that is having a bad day must not be moved back by their own
   * subscription.
   */
  it("lets the override win over the plan in both directions", () => {
    expect(mailboxRoute({ override: "direct", planId: "pro" })).toBe("direct")
    expect(mailboxRoute({ override: "ses", planId: "free" })).toBe("ses")
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
 * ⚠ THE MAILBOX RULE EXISTS TWICE, AND THIS IS THE ONLY THING HOLDING THE TWO
 * TOGETHER. `resolveMailboxRoute` is the rule in TypeScript; `core.resolve_route`
 * is the one Stalwart actually evaluates, in Postgres, because mailbox mail is submitted straight into Stalwart's queue by a
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
describe("the mailbox rule, mirrored in SQL", () => {
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
    // ⚠ FREE IS RECOGNISED BY NAME AND EVERYTHING ELSE IS TREATED AS PAID, so
    // renaming the free plan without moving `METERING_FREE_PLAN_ID` routes free
    // mailboxes to SES. Pinned as-is because the SQL does the same, and the two
    // must agree. Whether free mailbox mail should use SES at all is #191.
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
      expect(
        resolveMailboxRoute({ override, planId, freePlanId: "free", sesEnabled }),
      ).toBe(expected)
    })
  }
})
