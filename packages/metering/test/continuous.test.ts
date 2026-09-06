import { describe, expect, it, vi } from "vitest"
import { createMeter } from "../src/meter.js"
import { formatMeterKey } from "../src/key.js"
import type { Assignment, Entitlement, Plan } from "../src/plan.js"
import type { AssignmentStore, LevelStore, UsageStore } from "../src/ports.js"

/**
 * Continuous features: domains, mailboxes, storage.
 *
 * ⚠ THREE OF THE FOUR THINGS WE METER ARE THIS KIND, and the one the package
 * was originally built for — `emails` — is the exception. What these assert is
 * that nothing consumable leaks in: no window, no reset, no ledger read, and a
 * level that is allowed to go DOWN.
 */
const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const ANCHOR = new Date("2026-01-15T00:00:00.000Z")
const NOW = new Date("2026-06-01T00:00:00.000Z")

const held = (featureId: string, allowance: number | "unlimited"): Entitlement => ({
  kind: "continuous",
  featureId,
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

/** ⚠ Throws if touched: a continuous feature must never read the ledger. */
const forbiddenUsage: UsageStore = {
  usedIn: async () => {
    throw new Error("a continuous feature must not read the usage ledger")
  },
  record: async () => {
    throw new Error("a continuous feature must not write the usage ledger")
  },
}

const levelsOf = (byKey: Record<string, number>): LevelStore => ({
  levelOf: async (key) => byKey[formatMeterKey(key)] ?? 0,
})

describe("a domain limit", () => {
  const plan = planWith(held("domains.sending", 3))

  it("allows another while there is room", async () => {
    const meter = createMeter({
      assignments: assigned(plan),
      usage: forbiddenUsage,
      levels: levelsOf({ [`${TENANT}:domains.sending:0`]: 2 }),
    })

    expect(
      await meter.check({
        tenantId: TENANT,
        featureId: "domains.sending",
        requested: 1,
        at: NOW,
      }),
    ).toEqual({ status: "allowed", remaining: 0, resetsAt: null })
  })

  /**
   * ⚠ A HARD CAP, AND `overage: "never"` IS WHY. Nobody sells a fourth domain
   * for thirty cents, so the tenant's own overage switch must not be able to
   * buy one.
   */
  it("refuses the fourth even when the tenant enabled overage", async () => {
    const meter = createMeter({
      assignments: assigned(plan, true),
      usage: forbiddenUsage,
      levels: levelsOf({ [`${TENANT}:domains.sending:0`]: 3 }),
    })

    expect(
      await meter.check({
        tenantId: TENANT,
        featureId: "domains.sending",
        requested: 1,
        at: NOW,
      }),
    ).toEqual({ status: "exceeded", remaining: 0, shortfall: 1, resetsAt: null })
  })

  /**
   * ⚠ THE ONE AN APPEND-ONLY LEDGER COULD NOT DO. Delete a domain and the level
   * falls, so the slot comes back. No sum of recorded events can go down.
   */
  it("frees a slot when a domain is removed", async () => {
    const level = { count: 3 }
    const meter = createMeter({
      assignments: assigned(plan),
      usage: forbiddenUsage,
      levels: { levelOf: async () => level.count },
    })

    const ask = () =>
      meter.check({
        tenantId: TENANT,
        featureId: "domains.sending",
        requested: 1,
        at: NOW,
      })

    expect((await ask()).status).toBe("exceeded")
    level.count = 2
    expect((await ask()).status).toBe("allowed")
  })

  /**
   * ⚠ SENDING AND MAILBOX DOMAINS ARE TWO FEATURES, AND A DOMAIN THAT DOES BOTH
   * COUNTS IN BOTH. Each level is a count over its own flag rather than a
   * partition of one total — otherwise the cheapest way to hold a domain is to
   * claim both roles for it.
   */
  it("counts sending and mailbox domains separately", async () => {
    const meter = createMeter({
      assignments: assigned(
        planWith(held("domains.sending", 3), held("domains.mailbox", 1)),
      ),
      usage: forbiddenUsage,
      levels: levelsOf({
        [`${TENANT}:domains.sending:0`]: 2,
        [`${TENANT}:domains.mailbox:0`]: 1,
      }),
    })

    const at = NOW
    expect(
      (
        await meter.check({
          tenantId: TENANT,
          featureId: "domains.sending",
          requested: 1,
          at,
        })
      ).status,
    ).toBe("allowed")
    expect(
      (
        await meter.check({
          tenantId: TENANT,
          featureId: "domains.mailbox",
          requested: 1,
          at,
        })
      ).status,
    ).toBe("exceeded")
  })
})

describe("no window, ever", () => {
  const plan = planWith(held("mailboxes", 10))

  // ⚠ Asking when a mailbox refills is a category error. `null` here is "this
  // feature has no reset", which the caller must not read as "no plan".
  it("reports no reset", async () => {
    const meter = createMeter({
      assignments: assigned(plan),
      usage: forbiddenUsage,
      levels: levelsOf({}),
    })

    expect(
      await meter.windowOf({ tenantId: TENANT, featureId: "mailboxes", at: NOW }),
    ).toBeNull()
  })

  // The level is read as-is, at any distance from the anchor — there is no
  // boundary that could scope it and nothing that "expires".
  it("gives the same answer years after the anchor", async () => {
    const levelOf = vi.fn(async () => 4)
    const meter = createMeter({
      assignments: assigned(plan),
      usage: forbiddenUsage,
      levels: { levelOf },
    })

    for (const at of [NOW, new Date("2031-06-01T00:00:00.000Z")]) {
      expect(
        await meter.check({
          tenantId: TENANT,
          featureId: "mailboxes",
          requested: 1,
          at,
        }),
      ).toEqual({ status: "allowed", remaining: 5, resetsAt: null })
    }
    expect(levelOf).toHaveBeenCalledTimes(2)
  })
})

describe("storage, billed past the included amount", () => {
  const plan = planWith({
    kind: "continuous",
    featureId: "storage.gb",
    allowance: 10,
    overage: "billable",
  })

  it("splits the request when the tenant has opted in", async () => {
    const meter = createMeter({
      assignments: assigned(plan, true),
      usage: forbiddenUsage,
      levels: levelsOf({ [`${TENANT}:storage.gb:0`]: 8 }),
    })

    expect(
      await meter.check({
        tenantId: TENANT,
        featureId: "storage.gb",
        requested: 5,
        at: NOW,
      }),
    ).toEqual({ status: "overage", included: 2, billable: 3, resetsAt: null })
  })

  // ⚠ BOTH HALVES HAVE TO AGREE. The plan permitting overage is not consent.
  it("refuses when the plan permits overage but the tenant has not", async () => {
    const meter = createMeter({
      assignments: assigned(plan, false),
      usage: forbiddenUsage,
      levels: levelsOf({ [`${TENANT}:storage.gb:0`]: 8 }),
    })

    expect(
      (
        await meter.check({
          tenantId: TENANT,
          featureId: "storage.gb",
          requested: 5,
          at: NOW,
        })
      ).status,
    ).toBe("exceeded")
  })
})

/**
 * ⚠ A WIRING MISTAKE, AND BOTH QUIET ANSWERS ARE WORSE THAN THIS ONE.
 * `unentitled` would blame the customer's plan for our misconfiguration, and a
 * level of zero would grant everybody an unlimited number of mailboxes.
 */
describe("a continuous feature with no level store", () => {
  it("throws instead of guessing", async () => {
    const meter = createMeter({
      assignments: assigned(planWith(held("mailboxes", 10))),
      usage: forbiddenUsage,
    })

    await expect(
      meter.check({ tenantId: TENANT, featureId: "mailboxes", requested: 1, at: NOW }),
    ).rejects.toThrow(/no level store/)
  })
})
