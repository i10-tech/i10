import { describe, expect, it } from "bun:test"
import { formatUntil } from "../lib/format"

const NOW = Date.parse("2026-09-29T10:00:00Z")
const at = (ms: number) => new Date(NOW + ms).toISOString()

describe("formatUntil", () => {
  it("counts minutes, then hours and minutes, then days", () => {
    expect(formatUntil(at(30_000), NOW)).toBe("1 min")
    expect(formatUntil(at(12 * 60_000), NOW)).toBe("12 min")
    expect(formatUntil(at(5 * 3_600_000 + 12 * 60_000), NOW)).toBe("5 hr 12 min")
    expect(formatUntil(at(2 * 3_600_000), NOW)).toBe("2 hr")
    expect(formatUntil(at(12 * 86_400_000), NOW)).toBe("12 days")
    expect(formatUntil(at(30 * 3_600_000), NOW)).toBe("1 day")
  })

  it("never says zero or negative for a reset that has just passed", () => {
    expect(formatUntil(at(-5_000), NOW)).toBe("1 min")
  })
})
