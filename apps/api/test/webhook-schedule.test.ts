import { describe, expect, it } from "bun:test"
import {
  attemptsFor,
  nextDelayMs,
  parseRetryAfter,
  policyForPlan,
  POLICIES,
} from "../src/webhooks/schedule.js"

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

describe("retry windows by plan (decision 5)", () => {
  it("are shorter on Free and longer on paid plans", () => {
    const window = (p: keyof typeof POLICIES) => sum(POLICIES[p].gaps)
    expect(window("free")).toBe(5 + 60 + 600 + 1800 + 3600) // about 1h45m
    expect(window("pro") / 3600).toBeCloseTo(27.6, 1) // about 28h
    expect(window("scale") / 86_400).toBeCloseTo(2.65, 1) // about 3 days
    expect(window("free")).toBeLessThan(window("pro"))
    expect(window("pro")).toBeLessThan(window("scale"))
  })

  // ⚠ THE WINDOW NEVER OUTLASTS THE PLAN'S RETENTION. Free keeps 3 days and
  // Pro 30; a delivery retried after its row was deleted would be a ghost.
  it("never outlast the plan's data retention", () => {
    expect(sum(POLICIES.free.gaps)).toBeLessThan(3 * 86_400)
    expect(sum(POLICIES.pro.gaps)).toBeLessThan(30 * 86_400)
  })

  it("map plan ids, with no plan meaning Free and custom plans enterprise", () => {
    expect(policyForPlan(null)).toBe("free")
    expect(policyForPlan("free")).toBe("free")
    expect(policyForPlan("pro")).toBe("pro")
    expect(policyForPlan("scale")).toBe("scale")
    expect(policyForPlan("plan_0199a3f2custom")).toBe("enterprise")
  })

  it("count attempts as the gaps plus the first", () => {
    expect(attemptsFor("free")).toBe(6)
    expect(attemptsFor("pro")).toBe(8)
  })
})

describe("the next gap", () => {
  const mid = () => 0.5 // no jitter
  it("follows the policy, then stops", () => {
    expect(nextDelayMs("free", 1, {}, undefined, mid)).toBe(5_000)
    expect(nextDelayMs("free", 5, {}, undefined, mid)).toBe(3_600_000)
    expect(nextDelayMs("free", 6, {}, undefined, mid)).toBeNull()
  })

  it("jitters by at most 20% either way", () => {
    expect(nextDelayMs("pro", 2, {}, undefined, () => 0)).toBe(240_000)
    expect(nextDelayMs("pro", 2, {}, undefined, () => 1)).toBe(360_000)
  })

  it("puts the penalty and Retry-After after jitter, as floors", () => {
    expect(nextDelayMs("pro", 1, { status: 429 }, undefined, () => 0)).toBe(60_000)
    expect(nextDelayMs("pro", 1, { retryAfter: "30" }, undefined, () => 0)).toBe(30_000)
    expect(nextDelayMs("pro", 5, { retryAfter: "30" }, undefined, mid)).toBe(18_000_000)
  })
})

describe("Retry-After", () => {
  const now = new Date("2026-10-05T12:00:00Z")
  it.each([
    ["120", 120],
    ["1.2", 2],
    ["Mon, 05 Oct 2026 12:05:00 GMT", 300],
    ["Mon, 05 Oct 2026 11:00:00 GMT", 0],
  ])("reads %p as %p seconds", (raw, want) => {
    expect(parseRetryAfter(raw, now)).toBe(want)
  })
  it.each([null, "", "soon", "-5"])("refuses %p", (raw) => {
    expect(parseRetryAfter(raw as string | null, now)).toBeNull()
  })
})
