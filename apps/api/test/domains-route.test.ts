import { describe, expect, it } from "bun:test"
import {
  resolveRoute,
  type DeliveryRoute,
  type RouteOverride,
} from "../src/domains/route.js"

/**
 * Which MTA a domain's mail leaves through. Transactional mail uses this rule
 * directly; mailbox mail is evaluated by Stalwart through the SQL mirror,
 * `core.resolve_route`, and the two must never be able to disagree.
 */
const route = (over: Partial<Parameters<typeof resolveRoute>[0]> = {}) =>
  resolveRoute({ override: "auto", sesEnabled: true, ...over })

describe("transactional mail", () => {
  /**
   * ⚠ #155: EVERY PLAN GOES THROUGH SES, FREE INCLUDED. The plan is not even an
   * input - a free sender direct would sit on the IP our human mailboxes share,
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

describe("reading the kill switch out of the environment", () => {
  /**
   * ⚠ THE REGRESSION: `SES_ENABLED=0` USED TO MEAN ENABLED. The parser was
   * `raw !== "false"`, so every conventional falsy spelling silently left SES
   * on - on the one switch whose entire job is to be thrown mid-incident.
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
 * ⚠ THE SHARED RULE EXISTS TWICE, AND THIS IS THE ONLY THING HOLDING THE TWO
 * TOGETHER. `resolveRoute` is the TypeScript rule; `core.resolve_route` is the
 * one Stalwart actually evaluates in Postgres, because mailbox mail is submitted
 * straight into Stalwart's queue by a person's mail client and no code of ours
 * is in that path - the only way to ask us is a query.
 *
 * Two implementations of one rule drift, and the drift is silent: the dashboard
 * renders `ses` while the mail goes direct, and nobody finds out until somebody
 * compares them by hand. So the table below is asserted here against the
 * TypeScript and, character for character, inside `0132_mailbox_mail_all_ses.sql`
 * against the SQL - same order, same values, so the two read side by side in a
 * diff. The migration's `ASSERT`s run on deploy, which means a wrong SQL rule
 * fails the deploy rather than misrouting mail.
 *
 * ⚠ IF YOU ADD A CASE HERE, ADD IT THERE.
 */
describe("the mailbox rule, mirrored in SQL", () => {
  // ⚠ THE LAST COLUMN IS THE `DeliveryRoute` UNION, NOT `string`. bun types a
  // matcher against the value it received, so a widened `string` here stops the
  // expectation being checked against the real return type - and a typo in an
  // expected value becomes a failing assertion instead of a compile error.
  const cases: [string, RouteOverride, boolean, DeliveryRoute][] = [
    // The kill switch beats everything, including an explicit override.
    ["kill switch beats auto", "auto", false, "direct"],
    ["kill switch beats an ses override", "ses", false, "direct"],
    ["kill switch agrees with a direct override", "direct", false, "direct"],

    // An override wins when SES is enabled.
    ["ses override uses ses", "ses", true, "ses"],
    ["direct override uses direct", "direct", true, "direct"],

    // Otherwise auto uses SES.
    ["auto uses ses", "auto", true, "ses"],
  ]

  for (const [name, override, sesEnabled, expected] of cases) {
    it(name, () => {
      expect(resolveRoute({ override, sesEnabled })).toBe(expected)
    })
  }
})
