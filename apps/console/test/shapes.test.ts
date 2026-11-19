import { describe, expect, test } from "bun:test"
import {
  defineShape,
  encodeShape,
  mergeShapes,
  parseShapes,
  resolveShape,
  shapeFromText,
} from "@/lib/shapes"
import { domainsShape } from "@/lib/shapes/domains"

describe("remembered shapes", () => {
  const shape = { rows: 2, transfers: 1, statusFilter: true, regionFilter: false }

  test("round-trips through the cookie for its own workspace only", () => {
    const cookies = [{ name: "i10-shape-domains", value: encodeShape("t1", shape) }]
    const text = parseShapes(cookies, "t1").domains
    expect(shapeFromText(domainsShape, text)).toEqual(shape)
    expect(parseShapes(cookies, "t2")).toEqual({})
  })

  test("a malformed or out-of-range value falls back", () => {
    expect(shapeFromText(domainsShape, "{nope")).toEqual(domainsShape.fallback)
    expect(
      shapeFromText(domainsShape, JSON.stringify({ rows: -1, transfers: 0 })),
    ).toEqual(domainsShape.fallback)
    expect(
      shapeFromText(domainsShape, JSON.stringify({ ...shape, rows: 99 })).rows,
    ).toBe(10)
  })
})

describe("shapes merge rule", () => {
  const cookieShape = { rows: 2, transfers: 1, statusFilter: true, regionFilter: false }
  const cookieText = JSON.stringify(cookieShape)

  test("cookie beats count: cookie with flags wins over API count", () => {
    const cookieShapes = { domains: cookieText }
    const counts = { domains: 8, transfers: 0 }

    // Via resolveShape:
    const resolved = resolveShape(domainsShape, cookieText, counts)
    expect(resolved).toEqual(cookieShape)
    expect(resolved.statusFilter).toBe(true)

    // Via mergeShapes:
    const merged = mergeShapes(cookieShapes, counts, [domainsShape])
    expect(merged.domains).toBe(cookieText)
    expect(shapeFromText(domainsShape, merged.domains)).toEqual(cookieShape)
  })

  test("count beats fallback: API count fills in for a first visit with no cookie", () => {
    const cookieShapes: Record<string, string> = {}
    const counts = { domains: 5, transfers: 2 }

    // Via resolveShape:
    const resolved = resolveShape(domainsShape, null, counts)
    expect(resolved).toEqual({
      rows: 5,
      transfers: 2,
      statusFilter: false,
      regionFilter: false,
    })

    // Via mergeShapes:
    const merged = mergeShapes(cookieShapes, counts, [domainsShape])
    expect(shapeFromText(domainsShape, merged.domains)).toEqual({
      rows: 5,
      transfers: 2,
      statusFilter: false,
      regionFilter: false,
    })
  })

  test("missing key falls back: missing API count key falls back to default shape", () => {
    const cookieShapes: Record<string, string> = {}
    const counts = { other: 10 }

    // Via resolveShape:
    const resolved = resolveShape(domainsShape, null, counts)
    expect(resolved).toEqual(domainsShape.fallback)

    // Via mergeShapes:
    const merged = mergeShapes(cookieShapes, counts, [domainsShape])
    expect(merged.domains).toBeUndefined()
    expect(shapeFromText(domainsShape, merged.domains)).toEqual(domainsShape.fallback)
  })

  test("null or undefined counts object falls back to cookie or default", () => {
    const cookieShapes: Record<string, string> = {}
    const merged = mergeShapes(cookieShapes, null, [domainsShape])
    expect(shapeFromText(domainsShape, merged.domains)).toEqual(domainsShape.fallback)
    expect(resolveShape(domainsShape, null, null)).toEqual(domainsShape.fallback)
  })

  test("pages without fromCounts/fromCount simply ignore the call", () => {
    const customDef = defineShape({
      page: "other",
      fallback: { rows: 1 },
      of: () => ({ rows: 1 }),
      parse: (r: unknown) =>
        r && typeof r === "object" ? (r as { rows: number }) : null,
    })

    const merged = mergeShapes({}, { other: 5 }, [customDef])
    expect(merged.other).toBeUndefined()
    expect(resolveShape(customDef, null, { other: 5 })).toEqual(customDef.fallback)
  })

  test("domains shape handles missing transfers count by defaulting transfers to 0", () => {
    const counts = { domains: 4 }
    expect(resolveShape(domainsShape, null, counts)).toEqual({
      rows: 4,
      transfers: 0,
      statusFilter: false,
      regionFilter: false,
    })
  })
})
