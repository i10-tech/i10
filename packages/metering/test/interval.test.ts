import { describe, expect, it } from "vitest"
import { resetsAt, windowFor } from "../src/interval.js"

const at = (iso: string) => new Date(iso)
const iso = (d: Date | null) => (d === null ? null : d.toISOString())

describe("fixed-length intervals", () => {
  const anchor = at("2026-01-15T09:30:00.000Z")

  it("keeps the anchor's time of day", () => {
    const w = windowFor({ anchor, interval: "day", at: at("2026-03-02T04:00:00.000Z") })
    expect(iso(w.start)).toBe("2026-03-01T09:30:00.000Z")
    expect(iso(w.end)).toBe("2026-03-02T09:30:00.000Z")
  })

  it("counts weeks from the anchor, not from a calendar week", () => {
    const w = windowFor({
      anchor,
      interval: "week",
      at: at("2026-01-27T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2026-01-22T09:30:00.000Z")
    expect(iso(w.end)).toBe("2026-01-29T09:30:00.000Z")
  })

  it("multiplies by intervalCount", () => {
    // The first 30-day window runs 15 Jan 09:30 → 14 Feb 09:30, so 20 Feb is
    // already in the second one.
    const w = windowFor({
      anchor,
      interval: "day",
      intervalCount: 30,
      at: at("2026-02-20T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2026-02-14T09:30:00.000Z")
    expect(iso(w.end)).toBe("2026-03-16T09:30:00.000Z")
  })
})

describe("month boundaries", () => {
  /**
   * ⚠ THE REGRESSION TEST FOR THE BUG THIS PACKAGE EXISTS NOT TO HAVE. Autumn's
   * `addInterval` steps from the PREVIOUS boundary with date-fns `addMonths`,
   * which clamps — so a 31st anchor becomes the 28th after one February and
   * stays there for good. Deriving from the anchor keeps the clamp local.
   */
  it("returns to the anchor day after a short month", () => {
    const anchor = at("2026-01-31T00:00:00.000Z")

    // 15 Feb is still inside the FIRST window: February's boundary is the 28th,
    // which has not arrived yet.
    const first = windowFor({
      anchor,
      interval: "month",
      at: at("2026-02-15T00:00:00.000Z"),
    })
    expect(iso(first.start)).toBe("2026-01-31T00:00:00.000Z")
    expect(iso(first.end)).toBe("2026-02-28T00:00:00.000Z")

    // ⚠ THE ASSERTION THE WHOLE FILE EXISTS FOR. February clamped to the 28th,
    // and March goes straight back to the 31st. Stepping from the previous
    // boundary — what Autumn does — would give 28 March here and stay on the
    // 28th for good.
    const second = windowFor({
      anchor,
      interval: "month",
      at: at("2026-03-01T00:00:00.000Z"),
    })
    expect(iso(second.start)).toBe("2026-02-28T00:00:00.000Z")
    expect(iso(second.end)).toBe("2026-03-31T00:00:00.000Z")

    // April has 30 days, so it clamps too — again without affecting May.
    const third = windowFor({
      anchor,
      interval: "month",
      at: at("2026-04-10T00:00:00.000Z"),
    })
    expect(iso(third.start)).toBe("2026-03-31T00:00:00.000Z")
    expect(iso(third.end)).toBe("2026-04-30T00:00:00.000Z")
  })

  it("does not roll over before the day-of-month arrives", () => {
    const anchor = at("2026-01-20T12:00:00.000Z")
    const w = windowFor({
      anchor,
      interval: "month",
      at: at("2026-02-05T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2026-01-20T12:00:00.000Z")
    expect(iso(w.end)).toBe("2026-02-20T12:00:00.000Z")
  })

  it("treats a quarter as three months", () => {
    const anchor = at("2026-01-10T00:00:00.000Z")
    const w = windowFor({
      anchor,
      interval: "month",
      intervalCount: 3,
      at: at("2026-05-01T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2026-04-10T00:00:00.000Z")
    expect(iso(w.end)).toBe("2026-07-10T00:00:00.000Z")
  })

  it("carries the year correctly across December", () => {
    const anchor = at("2026-11-05T00:00:00.000Z")
    const w = windowFor({
      anchor,
      interval: "month",
      at: at("2027-01-20T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2027-01-05T00:00:00.000Z")
    expect(iso(w.end)).toBe("2027-02-05T00:00:00.000Z")
  })
})

describe("years", () => {
  it("clamps a 29 February anchor and then restores it", () => {
    const anchor = at("2028-02-29T00:00:00.000Z")
    expect(
      iso(
        windowFor({ anchor, interval: "year", at: at("2029-06-01T00:00:00.000Z") })
          .start,
      ),
    ).toBe("2029-02-28T00:00:00.000Z")
    expect(
      iso(
        windowFor({ anchor, interval: "year", at: at("2032-06-01T00:00:00.000Z") })
          .start,
      ),
    ).toBe("2032-02-29T00:00:00.000Z")
  })
})

describe("the properties that make this stateless", () => {
  const anchor = at("2026-01-31T00:00:00.000Z")

  /**
   * ⚠ THE WHOLE POINT. Autumn's reset advances one period per cron run, so a
   * process that has been down for years needs as many runs to catch up and
   * leaves the stored boundary in the past until it does. A computed window has
   * nothing to catch up on.
   */
  it("answers correctly after an outage of arbitrary length", () => {
    const w = windowFor({
      anchor,
      interval: "month",
      at: at("2031-07-14T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2031-06-30T00:00:00.000Z")
    expect(iso(w.end)).toBe("2031-07-31T00:00:00.000Z")
  })

  // ⚠ HALF-OPEN, SO AN INSTANT BELONGS TO EXACTLY ONE WINDOW. On the boundary
  // itself the new window has already begun.
  it("puts a boundary instant in the window it opens", () => {
    const boundary = at("2026-02-28T00:00:00.000Z")
    const w = windowFor({ anchor, interval: "month", at: boundary })
    expect(iso(w.start)).toBe("2026-02-28T00:00:00.000Z")
  })

  it("is idempotent across the window it describes", () => {
    const a = windowFor({
      anchor,
      interval: "month",
      at: at("2026-04-01T00:00:00.000Z"),
    })
    const b = windowFor({
      anchor,
      interval: "month",
      at: at("2026-04-29T23:59:59.999Z"),
    })
    expect(iso(a.start)).toBe(iso(b.start))
    expect(iso(a.end)).toBe(iso(b.end))
  })

  // Clocks disagree. A tenant whose plan was assigned by a server a few hundred
  // milliseconds ahead must not get an exception on their first send.
  it("returns the first window when asked about a moment before the anchor", () => {
    const w = windowFor({
      anchor,
      interval: "month",
      at: at("2025-12-01T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2026-01-31T00:00:00.000Z")
  })
})

describe("lifetime", () => {
  const anchor = at("2026-01-15T00:00:00.000Z")

  // ⚠ NOT "very long" — never. A lifetime allowance is consumed once.
  it("starts at the anchor and never ends", () => {
    const w = windowFor({
      anchor,
      interval: "lifetime",
      at: at("2099-01-01T00:00:00.000Z"),
    })
    expect(iso(w.start)).toBe("2026-01-15T00:00:00.000Z")
    expect(w.end).toBeNull()
  })

  it("has no reset", () => {
    expect(resetsAt({ anchor, interval: "lifetime", at: new Date() })).toBeNull()
  })
})

describe("refusals", () => {
  const anchor = at("2026-01-15T00:00:00.000Z")

  it("refuses an intervalCount that is not a positive integer", () => {
    for (const intervalCount of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        windowFor({ anchor, interval: "month", intervalCount, at: new Date() }),
      ).toThrow(RangeError)
    }
  })
})
