import { describe, expect, it } from "bun:test"
import { usageTone } from "../src/components/usage-ring"

/** The one colour rule the ring, the popover and the usage page share (#153). */
describe("usageTone", () => {
  it("is neutral, then yellow from 90%, then red AT a hard limit", () => {
    expect(usageTone({ used: 62, limit: 100 })).toBe("neutral")
    expect(usageTone({ used: 90, limit: 100 })).toBe("warning")
    expect(usageTone({ used: 100, limit: 100 })).toBe("danger")
    expect(usageTone({ used: 140, limit: 100 })).toBe("danger")
  })

  it("never alarms on overage: past the line is billing, not a wall", () => {
    expect(usageTone({ used: 95, limit: 100, overage: true })).toBe("neutral")
    expect(usageTone({ used: 100, limit: 100, overage: true })).toBe("neutral")
    expect(usageTone({ used: 120, limit: 100, overage: true })).toBe("info")
  })

  it("is neutral with no limit", () => {
    expect(usageTone({ used: 5_000, limit: null })).toBe("neutral")
  })
})
