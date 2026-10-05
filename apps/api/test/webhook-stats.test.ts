import { describe, expect, test } from "bun:test"
import { MAX_BUCKETS, statsWindow } from "../src/webhooks/stats.js"

const now = new Date("2026-10-06T10:37:12.000Z")

describe("statsWindow", () => {
  test("defaults to the last 24 hours, in hours, aligned to the hour", () => {
    const w = statsWindow({}, now)
    expect(w).toEqual({
      since: new Date("2026-10-05T10:00:00.000Z"),
      until: now,
      bucket: "hour",
    })
  })

  test("a range over a week defaults to days, aligned to UTC midnight", () => {
    const w = statsWindow({ since: new Date("2026-09-01T15:00:00Z") }, now)
    expect(w).toMatchObject({ since: new Date("2026-09-01T00:00:00Z"), bucket: "day" })
  })

  test("refuses a backwards window", () => {
    expect(
      statsWindow({ since: now, until: new Date(now.getTime() - 1) }, now),
    ).toEqual({
      error: "`since` must be before `until`.",
    })
  })

  test(`refuses more than ${MAX_BUCKETS} steps, and says how to fix it`, () => {
    const w = statsWindow(
      { since: new Date("2026-09-01T00:00:00Z"), bucket: "hour" },
      now,
    )
    expect("error" in w && w.error).toContain("larger bucket")
    // Exactly the limit is fine: 03:00 to 10:37 eight days later is 200
    // steps, the last one partial. An hour earlier is 201.
    const edge = (since: string) =>
      statsWindow({ since: new Date(since), until: now, bucket: "hour" }, now)
    expect("error" in edge("2026-09-28T03:00:00Z")).toBe(false)
    expect("error" in edge("2026-09-28T02:59:59Z")).toBe(true)
  })
})
