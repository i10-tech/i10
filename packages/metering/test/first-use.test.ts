import { describe, expect, it } from "bun:test"
import { createMeter } from "../src/meter.js"
import type { Assignment, Entitlement, Plan } from "../src/plan.js"
import type { UsageStore, WindowStore } from "../src/ports.js"

/**
 * `first_use` windows: a free limit starts at the first send, not at a fixed
 * boundary (decided 2026-09-29).
 *
 * ⚠ THE TEST THIS EXISTS FOR IS THE BURST. With anchored windows, 100 sent a
 * minute before the boundary and 100 a minute after is 200 in two minutes, all
 * allowed. With a window that opens on the first send, the second hundred is
 * refused until 24 hours after the first.
 */
const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const ANCHOR = new Date("2026-01-01T00:00:00.000Z")
const H = 3_600_000
const t = (hours: number) => new Date(ANCHOR.getTime() + hours * H)

const daily = (start?: "first_use"): Entitlement => ({
  kind: "consumable",
  featureId: "emails",
  allowance: 100,
  interval: "day",
  overage: "never",
  ...(start ? { start } : {}),
})

const plan = (e: Entitlement): Plan => ({
  id: "free",
  source: "catalog",
  entitlements: [e],
})

function world(e: Entitlement, planSince?: Date) {
  const events: Date[] = []
  const starts = new Map<string, Date>()
  const usage: UsageStore = {
    usedIn: async (_k, w) =>
      events.filter((at) => at >= w.start && (w.end === null || at < w.end)).length,
    record: async () => ({ recorded: 0, duplicates: 0 }),
    firstEventAt: async (_k, from, to) =>
      events.filter((at) => at >= from && at <= to).sort((a, b) => +a - +b)[0] ?? null,
  }
  const windows: WindowStore & { advanced: number } = {
    advanced: 0,
    startOf: async (_k, id) => starts.get(id) ?? null,
    advance: async (_k, id, start) => {
      const prev = starts.get(id)
      if (!prev || start > prev) {
        starts.set(id, start)
        windows.advanced++
      }
    },
  }
  const meter = createMeter({
    assignments: {
      find: async (tenantId) =>
        ({
          tenantId,
          plan: plan(e),
          anchor: ANCHOR,
          overageEnabled: false,
          ...(planSince ? { planSince: w.planSince ?? planSince } : {}),
        }) satisfies Assignment,
    },
    usage,
    windows,
  })
  // The plan change, movable mid-test.
  const w: { planSince?: Date } = { planSince }
  const send = (at: Date, n: number) => {
    for (let i = 0; i < n; i++) events.push(at)
  }
  const check = (at: Date, requested = 1) =>
    meter.check({ tenantId: TENANT, featureId: "emails", requested, at })
  const changePlan = (at: Date) => {
    w.planSince = at
  }
  return { meter, send, check, windows, changePlan }
}

describe("first_use windows", () => {
  it("the boundary burst: allowed on anchored windows, refused on first-use ones", async () => {
    // 100 sent a minute before the anchored boundary at +24h...
    const anchored = world(daily())
    anchored.send(t(23.98), 100)
    // ...and a minute after, the anchored window has reset.
    expect((await anchored.check(t(24.02), 100)).status).toBe("allowed")

    const first = world(daily("first_use"))
    first.send(t(23.98), 100)
    const after = await first.check(t(24.02), 100)
    expect(after.status).toBe("exceeded")
    // Refused until 24 hours after that first send.
    expect(after).toMatchObject({ resetsAt: t(47.98) })
  })

  it("counts nothing, and has no reset, until the first send", async () => {
    const w = world(daily("first_use"))
    const balance = await w.meter.balanceOf({
      tenantId: TENANT,
      featureId: "emails",
      at: t(5),
    })
    expect(balance).toMatchObject({
      status: "ok",
      used: 0,
      remaining: 100,
      window: null,
    })
    expect((await w.check(t(5))).status).toBe("allowed")
    expect(w.windows.advanced).toBe(0)
  })

  it("starts the next window at the next send after one ends, not at its end", async () => {
    const w = world(daily("first_use"))
    w.send(t(2), 100) // window A: +2h .. +26h
    expect((await w.check(t(10))).status).toBe("exceeded")
    // Nothing sent for two days; then a send at +60h opens window B there.
    w.send(t(60), 30)
    const b = await w.meter.balanceOf({
      tenantId: TENANT,
      featureId: "emails",
      at: t(61),
    })
    expect(b).toMatchObject({ used: 30, window: { start: t(60), end: t(84) } })
  })

  it("does not hand a tenant mid-window a fresh allowance on first read", async () => {
    // Nothing stored yet (first read after the deploy); 80 already sent 3h ago.
    const w = world(daily("first_use"))
    w.send(t(10), 80)
    const b = await w.meter.balanceOf({
      tenantId: TENANT,
      featureId: "emails",
      at: t(13),
    })
    expect(b).toMatchObject({ used: 80, remaining: 20, window: { start: t(10) } })
  })

  it("throws without a window store rather than falling back to the anchor", async () => {
    const meter = createMeter({
      assignments: {
        find: async (tenantId) =>
          ({
            tenantId,
            plan: plan(daily("first_use")),
            anchor: ANCHOR,
            overageEnabled: false,
          }) satisfies Assignment,
      },
      usage: {
        usedIn: async () => 0,
        record: async () => ({ recorded: 0, duplicates: 0 }),
      },
    })
    await expect(
      meter.check({ tenantId: TENANT, featureId: "emails", requested: 1, at: t(1) }),
    ).rejects.toThrow(/starts on first use/)
  })

  describe("plan changes", () => {
    const monthly: Entitlement = {
      kind: "consumable",
      featureId: "emails",
      allowance: 3000,
      interval: "month",
      overage: "never",
      start: "first_use",
    }

    it("Pro to Free: mail sent on Pro never counts against the free month", async () => {
      // 20,000 sent on Pro over the last ten days, then the downgrade lands.
      const w = world(monthly, t(0))
      for (let d = 0; d < 10; d++) w.send(t(d * 24), 2000)
      w.changePlan(t(240))
      const b = await w.meter.balanceOf({
        tenantId: TENANT,
        featureId: "emails",
        at: t(241),
      })
      expect(b).toMatchObject({ used: 0, remaining: 3000, window: null })
      // The free month opens on the first send after the change.
      w.send(t(242), 5)
      const after = await w.meter.balanceOf({
        tenantId: TENANT,
        featureId: "emails",
        at: t(243),
      })
      expect(after).toMatchObject({ used: 5, window: { start: t(242) } })
    })

    it("Free to Pro and back: the old free window is not resumed", async () => {
      const w = world(daily("first_use"), t(0))
      w.send(t(1), 100) // free day spent
      expect((await w.check(t(2))).status).toBe("exceeded")
      // Up to Pro at +3h (anchored, not under test here), sends 500, back to Free at +5h.
      w.send(t(4), 500)
      w.changePlan(t(5))
      const b = await w.meter.balanceOf({
        tenantId: TENANT,
        featureId: "emails",
        at: t(5.5),
      })
      expect(b).toMatchObject({ used: 0, window: null })
      expect((await w.check(t(5.5), 100)).status).toBe("allowed")
    })

    it("a window opened on this plan keeps counting when nothing changes", async () => {
      // planSince before everything: the same plan all along (a tier change
      // strict to normal does not move it either).
      const w = world(daily("first_use"), t(0))
      w.send(t(1), 60)
      w.send(t(3), 40)
      expect((await w.check(t(4))).status).toBe("exceeded")
    })
  })
})
