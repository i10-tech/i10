import { describe, expect, it } from "bun:test"
import {
  draftOf,
  draftSeconds,
  formatBounds,
  formatSeconds,
  outsideBounds,
  splitDuration,
  toSeconds,
} from "./duration"

describe("splitting seconds into a count and a unit", () => {
  it("picks the largest unit that divides evenly", () => {
    expect(splitDuration(86400 * 7)).toEqual({ value: 7, unit: "days" })
    expect(splitDuration(3600 * 8)).toEqual({ value: 8, unit: "hours" })
    expect(splitDuration(900)).toEqual({ value: 15, unit: "minutes" })
  })

  it("keeps a fraction instead of rounding a limit away", () => {
    expect(splitDuration(5400)).toEqual({ value: 90, unit: "minutes" })
    expect(splitDuration(90)).toEqual({ value: 1.5, unit: "minutes" })
  })
})

describe("turning a count and unit back into seconds", () => {
  it("round trips what it split", () => {
    for (const seconds of [900, 5400, 3600, 86400, 604800]) {
      const { value, unit } = splitDuration(seconds)
      expect(toSeconds(value, unit)).toBe(seconds)
    }
  })

  it("refuses zero, negatives and non-numbers", () => {
    expect(toSeconds(0, "hours")).toBeNull()
    expect(toSeconds(-1, "days")).toBeNull()
    expect(toSeconds(Number.NaN, "minutes")).toBeNull()
    expect(toSeconds(Number.POSITIVE_INFINITY, "minutes")).toBeNull()
  })

  it("always sends whole seconds", () => {
    expect(toSeconds(0.3333, "minutes")).toBe(20)
    expect(Number.isInteger(toSeconds(1.5555, "hours"))).toBe(true)
  })
})

describe("saying a duration", () => {
  it("pluralises", () => {
    expect(formatSeconds(3600)).toBe("1 hour")
    expect(formatSeconds(7200)).toBe("2 hours")
    expect(formatSeconds(86400)).toBe("1 day")
    expect(formatSeconds(5400)).toBe("90 minutes")
  })

  it("names the bounds the API returned", () => {
    expect(formatBounds({ min: 900, max: 90 * 86400 })).toBe("15 minutes to 90 days")
  })
})

describe("checking a duration against its bounds", () => {
  const bounds = { min: 900, max: 7776000 }
  it("says which side it falls off", () => {
    expect(outsideBounds(899, bounds)).toBe("below")
    expect(outsideBounds(7776001, bounds)).toBe("above")
  })
  it("accepts both ends", () => {
    expect(outsideBounds(900, bounds)).toBeNull()
    expect(outsideBounds(7776000, bounds)).toBeNull()
  })
})

describe("the limit editor", () => {
  const bounds = { min: 900, max: 7776000 }
  const fallback = { value: 8, unit: "hours" } as const

  it("starts from the stored limit in human units", () => {
    expect(draftOf(86400 * 2, fallback)).toEqual({ on: true, value: "2", unit: "days" })
    expect(draftOf(5400, fallback)).toEqual({ on: true, value: "90", unit: "minutes" })
  })

  it("starts switched off, with the fallback ready, for no limit", () => {
    expect(draftOf(null, fallback)).toEqual({ on: false, value: "8", unit: "hours" })
  })

  it("sends null for no limit whatever the fields hold", () => {
    expect(draftSeconds({ on: false, value: "junk", unit: "days" }, bounds)).toEqual({
      ok: true,
      seconds: null,
    })
  })

  it("sends seconds for a limit inside the bounds", () => {
    expect(draftSeconds({ on: true, value: "2", unit: "hours" }, bounds)).toEqual({
      ok: true,
      seconds: 7200,
    })
  })

  it("says why a limit cannot be sent", () => {
    expect(draftSeconds({ on: true, value: "", unit: "hours" }, bounds)).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(draftSeconds({ on: true, value: "abc", unit: "hours" }, bounds)).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(draftSeconds({ on: true, value: "5", unit: "minutes" }, bounds)).toEqual({
      ok: false,
      reason: "below",
    })
    expect(draftSeconds({ on: true, value: "91", unit: "days" }, bounds)).toEqual({
      ok: false,
      reason: "above",
    })
  })
})
