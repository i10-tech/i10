import { describe, expect, it } from "bun:test"
import { createMeter } from "../src/meter.js"
import type { Assignment, Entitlement, OveragePolicy, Plan } from "../src/plan.js"
import type { AssignmentStore, LevelStore, UsageStore } from "../src/ports.js"

/**
 * `balanceOf`: the read a usage page makes.
 *
 * ⚠ WHAT THESE PIN IS THE ONE THING `check` CANNOT SAY. `check({ requested: 0 })`
 * is always `allowed` — a zero-unit request consumes nothing, so refusing it
 * would be a quota error for a non-event — and the `remaining` it publishes is
 * clamped at zero so that no customer ever reads "-1,204 remaining". Both rules
 * are right for enforcement and both destroy the information a dashboard needs:
 * a tenant at 60,000 of 50,000 comes back from `check` looking exactly like one
 * at 50,000. Every test below would pass against the old derivation except the
 * ones that matter, which is why they are here.
 */

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const ANCHOR = new Date("2026-01-15T00:00:00.000Z")
const NOW = new Date("2026-01-15T06:00:00.000Z")

const emails = (
  allowance: number | "unlimited",
  overage: OveragePolicy = "never",
): Entitlement => ({
  kind: "consumable",
  featureId: "emails",
  allowance,
  interval: "day",
  overage,
})

const domains = (allowance: number | "unlimited"): Entitlement => ({
  kind: "continuous",
  featureId: "domains.sending",
  allowance,
  overage: "never",
})

const planWith = (...entitlements: Entitlement[]): Plan => ({
  id: "pro",
  source: "catalog",
  entitlements,
})

const assigned = (plan: Plan, overageEnabled = false): AssignmentStore => ({
  find: async (tenantId) =>
    tenantId === TENANT
      ? ({ tenantId, plan, anchor: ANCHOR, overageEnabled } satisfies Assignment)
      : null,
})

/**
 * A ledger holding one total, which is all these need.
 *
 * ⚠ IT IGNORES THE KEY AND THE WINDOW ON PURPOSE. What is under test is the
 * arithmetic `balanceOf` does with a usage figure, not the scoping of the read —
 * `meter.test.ts` already pins that an event outside the window is excluded.
 */
const ledger = (total: number): UsageStore => ({
  usedIn: async () => total,
  record: async () => ({ recorded: 0, duplicates: 0 }),
})

const levelsAt = (value: number): LevelStore => ({
  levelOf: async () => value,
})

describe("balanceOf", () => {
  it("reports usage, allowance and the window in one read", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(emails(100))),
      usage: ledger(40),
    })

    const balance = await meter.balanceOf({
      tenantId: TENANT,
      featureId: "emails",
      at: NOW,
    })

    expect(balance).toEqual({
      status: "ok",
      allowance: 100,
      used: 40,
      remaining: 60,
      overage: false,
      window: {
        start: new Date("2026-01-15T00:00:00.000Z"),
        end: new Date("2026-01-16T00:00:00.000Z"),
      },
    })
  })

  /**
   * ⚠ THE TEST THIS WHOLE METHOD EXISTS FOR. Derived from `check`, this tenant
   * reads as 50,000 of 50,000 — identical to somebody who stopped exactly on
   * the line — and the usage page can never draw the 10,000 they are being
   * billed for. `used` has to come back raw.
   */
  it("reports usage PAST the allowance rather than saturating at it", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(emails(50_000, "billable")), true),
      usage: ledger(60_000),
    })

    const balance = await meter.balanceOf({
      tenantId: TENANT,
      featureId: "emails",
      at: NOW,
    })

    expect(balance).toMatchObject({ status: "ok", allowance: 50_000, used: 60_000 })
  })

  /**
   * ⚠ AND `remaining` STAYS CLAMPED WHILE `used` DOES NOT. The asymmetry is the
   * design: `remaining` is the number enforcement publishes — into headers, into
   * error messages — and it must equal what `check` would say, to the unit.
   */
  it("clamps remaining at zero even when usage is past the line", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(emails(50_000, "billable")), true),
      usage: ledger(60_000),
    })

    const [balance, checked] = await Promise.all([
      meter.balanceOf({ tenantId: TENANT, featureId: "emails", at: NOW }),
      meter.check({ tenantId: TENANT, featureId: "emails", requested: 0, at: NOW }),
    ])

    expect(balance).toMatchObject({ remaining: 0 })
    expect(checked).toMatchObject({ status: "allowed", remaining: 0 })
  })

  /**
   * ⚠ THE OVERAGE FLAG IS THE TENANT'S EFFECTIVE POLICY, NOT THE PLAN'S ALONE.
   * It decides whether the console renders being over the line as a bill or as
   * a violation, and those are opposite messages to show somebody.
   */
  it("reports overage only when the plan bills it AND the tenant enabled it", async () => {
    const both = createMeter({
      assignments: assigned(planWith(emails(100, "billable")), true),
      usage: ledger(10),
    })
    const planOnly = createMeter({
      assignments: assigned(planWith(emails(100, "billable")), false),
      usage: ledger(10),
    })
    const tenantOnly = createMeter({
      assignments: assigned(planWith(emails(100, "never")), true),
      usage: ledger(10),
    })

    const ask = (meter: ReturnType<typeof createMeter>) =>
      meter.balanceOf({ tenantId: TENANT, featureId: "emails", at: NOW })

    expect(await ask(both)).toMatchObject({ overage: true })
    expect(await ask(planOnly)).toMatchObject({ overage: false })
    expect(await ask(tenantOnly)).toMatchObject({ overage: false })
  })

  /**
   * ⚠ `"unlimited"` COMES BACK AS ITSELF. Reporting it as a very large number
   * would have the console draw a bar that is always empty, which claims there
   * is an end somewhere off to the right. There is not.
   */
  it("passes an unlimited allowance through unchanged", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(emails("unlimited"))),
      usage: ledger(1_000_000),
    })

    expect(
      await meter.balanceOf({ tenantId: TENANT, featureId: "emails", at: NOW }),
    ).toMatchObject({
      allowance: "unlimited",
      used: 1_000_000,
      remaining: Number.POSITIVE_INFINITY,
    })
  })

  /**
   * ⚠ A CONTINUOUS FEATURE HAS NO WINDOW, AND THAT IS NOT THE SAME AS HAVING NO
   * PLAN. A domain limit does not reset; reporting `null` as "unentitled" would
   * tell a paying customer their plan grants them no domains.
   */
  it("reads a continuous feature as a level, with no window", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(domains(3))),
      usage: ledger(0),
      levels: levelsAt(4),
    })

    expect(
      await meter.balanceOf({
        tenantId: TENANT,
        featureId: "domains.sending",
        at: NOW,
      }),
    ).toEqual({
      status: "ok",
      allowance: 3,
      // ⚠ FOUR DOMAINS ON A THREE-DOMAIN PLAN, which is what a downgrade leaves
      // behind. The console has to be able to say so.
      used: 4,
      remaining: 0,
      overage: false,
      window: null,
    })
  })

  it("reports a tenant with no plan as unentitled rather than as empty", async () => {
    const meter = createMeter({
      assignments: { find: async () => null },
      usage: ledger(0),
    })

    expect(
      await meter.balanceOf({ tenantId: TENANT, featureId: "emails", at: NOW }),
    ).toMatchObject({ status: "unentitled" })
  })

  it("reports a plan that grants nothing for the feature as unentitled", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(emails(100))),
      usage: ledger(0),
    })

    expect(
      await meter.balanceOf({ tenantId: TENANT, featureId: "storage.bytes", at: NOW }),
    ).toMatchObject({ status: "unentitled" })
  })

  /**
   * ⚠ NO LEVEL STORE IS A WIRING MISTAKE AND THROWS, exactly as it does in
   * `check`. Answering zero would tell the console the tenant holds no domains,
   * which reads as "you have your whole allowance left" — the most dangerous
   * wrong answer available.
   */
  it("throws for a continuous feature with no level store, like check does", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(domains(3))),
      usage: ledger(0),
    })

    await expect(
      meter.balanceOf({ tenantId: TENANT, featureId: "domains.sending", at: NOW }),
    ).rejects.toThrow(/no level store/)
  })
})
