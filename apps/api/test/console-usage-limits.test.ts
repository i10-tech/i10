import { describe, expect, it } from "bun:test"
import type { BalanceOutcome, Meter } from "@repo/metering"
import { usageStore } from "../src/console/usage.js"

/**
 * The usage page's sending limits: one row per window, like Claude's session
 * and weekly rows. What matters is that a free workspace sees BOTH lines that
 * can refuse it, and a paid one sees its month and an explicit "no daily limit".
 */
const NOW = new Date("2026-09-29T10:00:00Z")

const meterOf = (balance: BalanceOutcome | Error): Meter =>
  ({
    balanceOf: async () => {
      if (balance instanceof Error) throw balance
      return balance
    },
  }) as unknown as Meter

const window = (end: string) => ({ start: new Date(0), end: new Date(end) })

const freeDay: BalanceOutcome = {
  status: "ok",
  allowance: 100,
  used: 50,
  remaining: 50,
  overage: false,
  window: window("2026-09-30T00:00:00Z"),
  interval: "day",
  intervalCount: 1,
}

const tierMonth: BalanceOutcome = {
  status: "ok",
  allowance: 3000,
  used: 1840,
  remaining: 1160,
  overage: false,
  window: window("2026-10-12T00:00:00Z"),
  interval: "month",
  intervalCount: 1,
}

const proMonth: BalanceOutcome = {
  status: "ok",
  allowance: 50_000,
  used: 1200,
  remaining: 48_800,
  overage: true,
  window: window("2026-10-04T00:00:00Z"),
  interval: "month",
  intervalCount: 1,
}

const store = (plan: Meter, tier: BalanceOutcome) =>
  usageStore({
    db: {} as never,
    meter: plan,
    tiers: {
      meter: meterOf(tier),
      store: { current: async () => ({ tier: "normal" }) } as never,
    },
    now: () => NOW,
  })

describe("sending limits", () => {
  it("shows a free workspace its daily plan line and its monthly tier line", async () => {
    const limits = await store(meterOf(freeDay), tierMonth).limits("t")
    expect(limits).toEqual([
      {
        window: "day",
        count: 1,
        source: "plan",
        used: 50,
        allowance: 100,
        remaining: 50,
        resets_at: "2026-09-30T00:00:00.000Z",
        overage: false,
        starts_on_send: false,
        status: "ok",
      },
      {
        window: "month",
        count: 1,
        source: "tier",
        tier: "normal",
        used: 1840,
        allowance: 3000,
        remaining: 1160,
        resets_at: "2026-10-12T00:00:00.000Z",
        overage: false,
        starts_on_send: false,
        status: "ok",
      },
    ])
  })

  it("shows a paid workspace its month, and says it has no daily limit", async () => {
    const limits = await store(meterOf(proMonth), {
      status: "unentitled",
      reason: "not free",
    }).limits("t")
    expect(limits.map((l) => [l.window, l.source, l.allowance])).toEqual([
      ["day", "none", null],
      ["month", "plan", 50_000],
    ])
    expect(limits[0]!.status).toBe("ok")
    expect(limits[1]!.overage).toBe(true)
  })

  it("never says 'no daily limit' when it could not read the plan", async () => {
    const limits = await store(meterOf(new Error("db down")), tierMonth).limits("t")
    const day = limits.find((l) => l.window === "day")!
    expect(day.status).toBe("unreadable")
    expect(limits.find((l) => l.window === "month")!.source).toBe("tier")
  })

  it("adds a row for any other window a plan defines, in order", async () => {
    const weekly: BalanceOutcome = { ...proMonth, interval: "week", overage: false }
    const limits = await store(meterOf(weekly), {
      status: "unentitled",
      reason: "not free",
    }).limits("t")
    expect(limits.map((l) => l.window)).toEqual(["day", "week", "month"])
  })

  it("says a free limit starts with the next send when no window is open", async () => {
    const idle: BalanceOutcome = { ...freeDay, used: 0, remaining: 100, window: null }
    const limits = await store(meterOf(idle), tierMonth).limits("t")
    expect(limits[0]).toMatchObject({
      window: "day",
      starts_on_send: true,
      resets_at: null,
    })
  })
})
