import { describe, expect, it } from "bun:test"
import { ALL_TIME, defaultEmailsRange, rangeStart } from "@/lib/range"

/**
 * The delivery log filtered by an API key reads the last 30 days unless a
 * range was picked (#507); All time is still there, as `?days=all`.
 */
describe("the delivery log's range under an API key filter", () => {
  it("defaults to 30 days with a key and to all time without one", () => {
    expect(defaultEmailsRange("key_1")).toBe("30")
    expect(defaultEmailsRange(undefined)).toBeUndefined()
  })

  it("reads 30 days back for the default", () => {
    const from = Date.parse(rangeStart(defaultEmailsRange("key_1"))!)
    expect(Date.now() - from).toBeCloseTo(30 * 86_400_000, -4)
  })

  it("reads all time when All time was picked", () => {
    expect(rangeStart(ALL_TIME)).toBeUndefined()
  })
})
