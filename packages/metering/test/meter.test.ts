import { describe, expect, it } from "vitest"
import { createMeter } from "../src/meter.js"
import { formatMeterKey } from "../src/key.js"
import type { ResetWindow } from "../src/interval.js"
import type { Assignment, Entitlement, OveragePolicy, Plan } from "../src/plan.js"
import type {
  AssignmentStore,
  RecordResult,
  UsageEvent,
  UsageStore,
} from "../src/ports.js"
import type { MeterKey } from "../src/key.js"

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const at = (iso: string) => new Date(iso)
const ANCHOR = at("2026-01-15T00:00:00.000Z")

const free: Plan = {
  id: "free",
  source: "catalog",
  entitlements: [emails(100, "day")],
}

const pro: Plan = {
  id: "pro",
  source: "catalog",
  entitlements: [emails(50_000, "month")],
}

function emails(
  allowance: number,
  interval: "day" | "month" | "lifetime",
  overage: OveragePolicy = "never",
): Entitlement {
  return { kind: "consumable", featureId: "emails", allowance, interval, overage }
}

const assigned = (
  plan: Plan,
  { anchor = ANCHOR, overageEnabled = false } = {},
): AssignmentStore => ({
  find: async (tenantId) =>
    tenantId === TENANT
      ? ({ tenantId, plan, anchor, overageEnabled } satisfies Assignment)
      : null,
})

/** ⚠ Idempotent on `id`, because a real adapter has to be. */
function memoryUsage(seed: readonly (UsageEvent & { key: string })[] = []) {
  const rows = new Map<string, UsageEvent & { key: string }>()
  for (const row of seed) rows.set(`${row.key}/${row.id}`, row)

  const store: UsageStore = {
    async usedIn(key: MeterKey, window: ResetWindow) {
      const name = formatMeterKey(key)
      let total = 0
      for (const row of rows.values()) {
        if (row.key !== name) continue
        if (row.at < window.start) continue
        if (window.end !== null && row.at >= window.end) continue
        total += row.value
      }
      return total
    },
    async record(key: MeterKey, events: readonly UsageEvent[]) {
      const name = formatMeterKey(key)
      const result: RecordResult = { recorded: 0, duplicates: 0 }
      for (const event of events) {
        const id = `${name}/${event.id}`
        if (rows.has(id)) {
          result.duplicates += 1
          continue
        }
        rows.set(id, { ...event, key: name })
        result.recorded += 1
      }
      return result
    },
  }

  return { store, rows }
}

const usageAt = (id: string, iso: string, value = 1) => ({
  id,
  at: at(iso),
  value,
})

describe("checking", () => {
  it("allows a request that fits the window's allowance", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({ assignments: assigned(free), usage: store })

    const outcome = await meter.check({
      tenantId: TENANT,
      featureId: "emails",
      requested: 10,
      at: at("2026-01-15T06:00:00.000Z"),
    })

    expect(outcome).toEqual({
      status: "allowed",
      remaining: 90,
      resetsAt: at("2026-01-16T00:00:00.000Z"),
    })
  })

  it("counts only what was used inside the current window", async () => {
    const key = `${TENANT}:emails:0`
    const { store } = memoryUsage([
      // Yesterday. Spent, and irrelevant to today's allowance.
      { ...usageAt("m1", "2026-01-15T23:00:00.000Z", 80), key },
      { ...usageAt("m2", "2026-01-16T01:00:00.000Z", 30), key },
    ])
    const meter = createMeter({ assignments: assigned(free), usage: store })

    const outcome = await meter.check({
      tenantId: TENANT,
      featureId: "emails",
      requested: 10,
      at: at("2026-01-16T09:00:00.000Z"),
    })

    expect(outcome).toEqual({
      status: "allowed",
      remaining: 60,
      resetsAt: at("2026-01-17T00:00:00.000Z"),
    })
  })

  it("refuses a batch outright and says when the allowance returns", async () => {
    const key = `${TENANT}:emails:0`
    const { store } = memoryUsage([
      { ...usageAt("m1", "2026-01-15T06:00:00.000Z", 90), key },
    ])
    const meter = createMeter({ assignments: assigned(free), usage: store })

    expect(
      await meter.check({
        tenantId: TENANT,
        featureId: "emails",
        requested: 25,
        at: at("2026-01-15T07:00:00.000Z"),
      }),
    ).toEqual({
      status: "exceeded",
      remaining: 10,
      shortfall: 15,
      resetsAt: at("2026-01-16T00:00:00.000Z"),
    })
  })

  it("never ends the window of a lifetime allowance", async () => {
    const credits: Plan = {
      id: "credit-pack",
      source: "custom",
      entitlements: [emails(500, "lifetime")],
    }
    const { store } = memoryUsage()
    const meter = createMeter({ assignments: assigned(credits), usage: store })

    const outcome = await meter.check({
      tenantId: TENANT,
      featureId: "emails",
      requested: 1,
      at: at("2030-01-01T00:00:00.000Z"),
    })

    expect(outcome).toMatchObject({ status: "allowed", resetsAt: null })
  })
})

/**
 * ⚠ THE OUTCOME THAT MUST NOT BE REPORTED AS "OVER QUOTA". Both cases below are
 * our misconfiguration, and both would otherwise tell a customer who has sent
 * nothing that they have used their allowance.
 */
describe("unentitled", () => {
  it("says so when the tenant holds no plan", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({
      assignments: { find: async () => null },
      usage: store,
    })

    const outcome = await meter.check({
      tenantId: TENANT,
      featureId: "emails",
      requested: 1,
      at: ANCHOR,
    })

    expect(outcome.status).toBe("unentitled")
  })

  it("says so when the plan grants nothing for the feature", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({ assignments: assigned(free), usage: store })

    const outcome = await meter.check({
      tenantId: TENANT,
      featureId: "sms",
      requested: 1,
      at: ANCHOR,
    })

    expect(outcome.status).toBe("unentitled")
  })

  /**
   * ⚠ A STORAGE FAILURE IS NOT AN ABSENCE. It propagates, so the caller can
   * report `unavailable` and fail open rather than telling everyone they are
   * over quota during an incident.
   */
  it("propagates a storage failure rather than reading it as no plan", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({
      assignments: {
        find: async () => {
          throw new Error("connection refused")
        },
      },
      usage: store,
    })

    await expect(
      meter.check({
        tenantId: TENANT,
        featureId: "emails",
        requested: 1,
        at: ANCHOR,
      }),
    ).rejects.toThrow("connection refused")
  })
})

describe("recording", () => {
  it("reports replays as duplicates rather than counting them twice", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({ assignments: assigned(free), usage: store })
    const events = [
      usageAt("msg_1", "2026-01-15T06:00:00.000Z"),
      usageAt("msg_2", "2026-01-15T06:00:01.000Z"),
    ]

    expect(
      await meter.record({ tenantId: TENANT, featureId: "emails", events }),
    ).toEqual({ recorded: 2, duplicates: 0 })
    expect(
      await meter.record({ tenantId: TENANT, featureId: "emails", events }),
    ).toEqual({ recorded: 0, duplicates: 2 })

    const outcome = await meter.check({
      tenantId: TENANT,
      featureId: "emails",
      requested: 1,
      at: at("2026-01-15T07:00:00.000Z"),
    })
    expect(outcome).toMatchObject({ remaining: 97 })
  })

  /**
   * ⚠ THE MAIL HAS ALREADY GONE. A plan that cannot be resolved must not be
   * able to lose the record of what was sent — it is also how the reconciler
   * finds a tenant whose plan was never assigned.
   */
  it("records usage for a tenant holding no plan", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({
      assignments: { find: async () => null },
      usage: store,
    })

    expect(
      await meter.record({
        tenantId: TENANT,
        featureId: "emails",
        events: [usageAt("msg_1", "2026-01-15T06:00:00.000Z")],
      }),
    ).toEqual({ recorded: 1, duplicates: 0 })
  })

  it("keeps shards apart", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({ assignments: assigned(free), usage: store })
    const events = [usageAt("msg_1", "2026-01-15T06:00:00.000Z", 40)]

    await meter.record({ tenantId: TENANT, featureId: "emails", events, shard: 0 })
    await meter.record({
      tenantId: TENANT,
      featureId: "emails",
      events: [usageAt("msg_2", "2026-01-15T06:00:00.000Z", 40)],
      shard: 1,
    })

    // Each shard gates against its own count. Summing them is the ledger's job.
    for (const shard of [0, 1]) {
      expect(
        await meter.check({
          tenantId: TENANT,
          featureId: "emails",
          requested: 1,
          at: at("2026-01-15T07:00:00.000Z"),
          shard,
        }),
      ).toMatchObject({ remaining: 59 })
    }
  })
})

/**
 * ⚠ THE ANCHOR BELONGS TO THE TENANT, NOT TO THE PLAN. Anchoring to the plan
 * would hand every customer a free reset — exhaust the allowance, change plan,
 * start a new window — and would make two windows overlap at the moment of the
 * change, so the ledger's buckets stop partitioning time.
 */
describe("a plan change mid-window", () => {
  it("applies the new allowance to the usage already recorded", async () => {
    const key = `${TENANT}:emails:0`
    const { store } = memoryUsage([
      { ...usageAt("m1", "2026-02-01T06:00:00.000Z", 100), key },
    ])
    const now = at("2026-02-01T09:00:00.000Z")

    const onFree = createMeter({ assignments: assigned(free), usage: store })
    expect(
      await onFree.check({
        tenantId: TENANT,
        featureId: "emails",
        requested: 1,
        at: now,
      }),
    ).toMatchObject({ status: "exceeded", remaining: 0 })

    // Upgrading is felt immediately, and the hundred already sent still count.
    const onPro = createMeter({ assignments: assigned(pro), usage: store })
    expect(
      await onPro.check({
        tenantId: TENANT,
        featureId: "emails",
        requested: 1,
        at: now,
      }),
    ).toEqual({
      status: "allowed",
      remaining: 49_899,
      resetsAt: at("2026-02-15T00:00:00.000Z"),
    })
  })
})

describe("windowOf", () => {
  it("reports the window a tenant is standing in", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({ assignments: assigned(pro), usage: store })

    expect(
      await meter.windowOf({
        tenantId: TENANT,
        featureId: "emails",
        at: at("2026-03-02T00:00:00.000Z"),
      }),
    ).toEqual({
      start: at("2026-02-15T00:00:00.000Z"),
      end: at("2026-03-15T00:00:00.000Z"),
    })
  })

  it("is null when nothing is entitled", async () => {
    const { store } = memoryUsage()
    const meter = createMeter({
      assignments: { find: async () => null },
      usage: store,
    })
    expect(
      await meter.windowOf({ tenantId: TENANT, featureId: "emails", at: ANCHOR }),
    ).toBeNull()
  })
})

/**
 * The consumable half of the overage rule — the continuous half is in
 * continuous.test.ts. Both must agree, because the resolution happens once in
 * `createMeter` for either kind.
 */
describe("emails past the plan", () => {
  const proBillable: Plan = {
    id: "pro",
    source: "catalog",
    entitlements: [emails(50_000, "month", "billable")],
  }
  const key = `${TENANT}:emails:0`
  const seeded = () =>
    memoryUsage([{ ...usageAt("m1", "2026-02-01T06:00:00.000Z", 49_900), key }])
  const now = at("2026-02-01T09:00:00.000Z")

  it("splits the batch and keeps the reset date", async () => {
    const meter = createMeter({
      assignments: assigned(proBillable, { overageEnabled: true }),
      usage: seeded().store,
    })

    expect(
      await meter.check({
        tenantId: TENANT,
        featureId: "emails",
        requested: 300,
        at: now,
      }),
    ).toEqual({
      status: "overage",
      included: 100,
      billable: 200,
      resetsAt: at("2026-02-15T00:00:00.000Z"),
    })
  })

  // ⚠ The plan permitting overage is not the customer consenting to it.
  it("refuses when the tenant has not switched it on", async () => {
    const meter = createMeter({
      assignments: assigned(proBillable, { overageEnabled: false }),
      usage: seeded().store,
    })

    expect(
      (
        await meter.check({
          tenantId: TENANT,
          featureId: "emails",
          requested: 300,
          at: now,
        })
      ).status,
    ).toBe("exceeded")
  })

  // ⚠ And the customer switching it on cannot override a plan that says never.
  it("refuses when the plan says never, however the switch is set", async () => {
    const meter = createMeter({
      assignments: assigned(pro, { overageEnabled: true }),
      usage: memoryUsage([
        { ...usageAt("m1", "2026-02-01T06:00:00.000Z", 50_000), key },
      ]).store,
    })

    expect(
      (
        await meter.check({
          tenantId: TENANT,
          featureId: "emails",
          requested: 1,
          at: now,
        })
      ).status,
    ).toBe("exceeded")
  })
})
