import { describe, expect, it } from "bun:test"
import { formatRelative } from "./format"

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const at = (offset: number) => new Date(NOW + offset).toISOString()

describe("formatRelative", () => {
  it("reads past instants as ago", () => {
    expect(formatRelative(at(-10 * SECOND), NOW)).toBe("just now")
    expect(formatRelative(at(-60 * SECOND), NOW)).toBe("a minute ago")
    expect(formatRelative(at(-5 * MINUTE), NOW)).toBe("5 minutes ago")
    expect(formatRelative(at(-1 * HOUR), NOW)).toBe("1 hour ago")
    expect(formatRelative(at(-3 * HOUR), NOW)).toBe("3 hours ago")
    expect(formatRelative(at(-2 * DAY), NOW)).toBe("2 days ago")
    expect(formatRelative(at(-7 * DAY), NOW)).toBe("Oct 27")
  })

  it("reads future instants as in", () => {
    expect(formatRelative(at(10 * SECOND), NOW)).toBe("just now")
    expect(formatRelative(at(60 * SECOND), NOW)).toBe("in a minute")
    expect(formatRelative(at(5 * MINUTE), NOW)).toBe("in 5 minutes")
    expect(formatRelative(at(1 * HOUR), NOW)).toBe("in 1 hour")
    expect(formatRelative(at(3 * HOUR), NOW)).toBe("in 3 hours")
    expect(formatRelative(at(1 * DAY), NOW)).toBe("in 1 day")
    expect(formatRelative(at(7 * DAY), NOW)).toBe("in 7 days")
    expect(formatRelative(at(10 * DAY), NOW)).toBe("Nov 13")
  })

  it("adds the year to a date outside the current one", () => {
    expect(formatRelative(at(90 * DAY), NOW)).toBe("Feb 1, 2027")
  })

  it("returns an unparseable value unchanged", () => {
    expect(formatRelative("not a date", NOW)).toBe("not a date")
  })
})
