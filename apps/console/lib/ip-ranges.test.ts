import { describe, expect, it } from "bun:test"
import { parseRanges, rangesToText, sameRanges } from "./ip-ranges"

describe("reading the ranges box", () => {
  it("takes one per line and trims", () => {
    expect(parseRanges("  10.0.0.0/8 \n203.0.113.7\n")).toEqual([
      "10.0.0.0/8",
      "203.0.113.7",
    ])
  })

  it("also splits on commas, semicolons and spaces", () => {
    expect(parseRanges("10.0.0.0/8, 192.168.0.0/16;2001:db8::/32 1.1.1.1")).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
      "2001:db8::/32",
      "1.1.1.1",
    ])
  })

  it("drops blanks and repeats, keeping the first", () => {
    expect(parseRanges("\n\n1.1.1.1\n\n1.1.1.1\n2.2.2.2\n1.1.1.1")).toEqual([
      "1.1.1.1",
      "2.2.2.2",
    ])
  })

  it("is empty for nothing", () => {
    expect(parseRanges("")).toEqual([])
    expect(parseRanges(" \n , ; ")).toEqual([])
  })

  it("leaves an invalid entry for the API to name", () => {
    expect(parseRanges("not-an-ip")).toEqual(["not-an-ip"])
  })
})

describe("showing ranges as text", () => {
  it("round trips", () => {
    const ranges = ["10.0.0.0/8", "203.0.113.7"]
    expect(parseRanges(rangesToText(ranges))).toEqual(ranges)
  })

  it("compares by entries and order", () => {
    expect(sameRanges(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameRanges(["a", "b"], ["b", "a"])).toBe(false)
    expect(sameRanges(["a"], ["a", "b"])).toBe(false)
  })
})
