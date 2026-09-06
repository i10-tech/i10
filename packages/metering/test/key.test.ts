import { describe, expect, it } from "vitest"
import { formatMeterKey, meterKey, meterKeyOf, parseMeterKey } from "../src/key.js"

const TENANT = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"

describe("meter keys", () => {
  it("addresses a meter by tenant, feature and shard", () => {
    expect(meterKey(TENANT, "emails")).toBe(`${TENANT}:emails:0`)
    expect(meterKey(TENANT, "emails", 7)).toBe(`${TENANT}:emails:7`)
  })

  // ⚠ THE SHARD IS PRESENT EVEN THOUGH NOTHING SHARDS. Widening the key later
  // would mean migrating every stored row and every Durable Object name at once.
  it("includes the shard when nothing has been sharded", () => {
    expect(meterKey(TENANT, "emails").endsWith(":0")).toBe(true)
  })

  it("round-trips", () => {
    const key = meterKeyOf(TENANT, "emails", 3)
    expect(parseMeterKey(formatMeterKey(key))).toEqual(key)
  })
})

describe("refusals", () => {
  /**
   * ⚠ THE ONE THAT WOULD BE SILENT. `emails:eu` parses back as feature `emails`
   * on shard `eu`, so usage lands under a meter nobody queries and the tenant
   * appears to have sent nothing.
   */
  it("refuses a separator inside a part", () => {
    expect(() => meterKey(TENANT, "emails:eu")).toThrow(RangeError)
    expect(() => meterKey("a:b", "emails")).toThrow(RangeError)
  })

  it("refuses an empty part", () => {
    expect(() => meterKey("", "emails")).toThrow(RangeError)
    expect(() => meterKey(TENANT, "")).toThrow(RangeError)
  })

  it("refuses a shard that is not a non-negative integer", () => {
    for (const shard of [-1, 1.5, Number.NaN]) {
      expect(() => meterKey(TENANT, "emails", shard)).toThrow(RangeError)
    }
  })

  it("refuses a string that is not a key", () => {
    for (const bad of [TENANT, `${TENANT}:emails`, `${TENANT}:emails:0:extra`, ""]) {
      expect(() => parseMeterKey(bad)).toThrow(RangeError)
    }
  })

  it("refuses a key whose shard is not a number", () => {
    expect(() => parseMeterKey(`${TENANT}:emails:eu`)).toThrow(RangeError)
  })
})
