import { describe, expect, it } from "bun:test"
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  escapeLike,
} from "../src/console/queries.js"

/**
 * The three primitives every list on the console surface is built from.
 *
 * ⚠ ALL THREE FAIL SILENTLY WHEN THEY ARE WRONG, WHICH IS WHY THEY ARE TESTED
 * AND THE QUERIES AROUND THEM ARE NOT. A broken cursor does not throw — it
 * skips a page of somebody's delivery log. A broken `escapeLike` does not throw
 * — it turns a search for a literal `%` into a scan that matches everything. A
 * broken `clampLimit` does not throw — it lets a caller ask for a million rows
 * from a partitioned table.
 */

describe("cursor", () => {
  /**
   * ⚠ MICROSECOND PRECISION HAS TO SURVIVE, WHICH IS WHY THE TIMESTAMP IS
   * CARRIED AS THE TEXT POSTGRES RENDERED RATHER THAN AS A `Date`. A `Date` is
   * millisecond precision; a `timestamptz` is microsecond. A cursor rounded
   * down to the millisecond makes the next page ask for `created_at < T.000`,
   * and a row at `T.000200` — older, and legitimately on that page — compares
   * GREATER and is skipped by every page, forever.
   */
  it("round-trips the timestamp exactly as Postgres rendered it", () => {
    const at = "2026-09-17 14:32:05.000123+00"
    const id = "0199c1a2-3b4c-7d5e-8f90-1a2b3c4d5e6f"

    const decoded = decodeCursor(encodeCursor(at, id))

    expect(decoded).not.toBeNull()
    expect(decoded!.at).toBe(at)
    expect(decoded!.id).toBe(id)
  })

  it("keeps the microseconds a Date would have truncated", () => {
    const decoded = decodeCursor("2026-09-17 14:32:05.000500+00|abc")
    // The bug this replaces produced "…05.000Z" and lost the 500µs.
    expect(decoded!.at).toBe("2026-09-17 14:32:05.000500+00")
  })

  it("accepts the ISO spelling too, since both reach the same cast", () => {
    expect(decodeCursor("2026-09-17T14:32:05.123Z|abc")?.at).toBe(
      "2026-09-17T14:32:05.123Z",
    )
  })

  /**
   * ⚠ THE SEPARATOR IS FOUND FROM THE LEFT, AND THE SUPPRESSION LIST IS WHY.
   * Its cursor's id half is an EMAIL ADDRESS, not a uuid, and a quoted local
   * part may legally contain a `|`. An ISO timestamp never can — so splitting
   * at the first separator always yields the whole timestamp and the whole id.
   * Splitting at the LAST one would truncate such an address and page past a
   * row rather than to it. This test was written expecting `lastIndexOf` and
   * failed, which is how the bug was found.
   */
  it("splits on the first separator, so an id may contain one", () => {
    const decoded = decodeCursor('2026-09-17 14:32:05.123+00|"odd|name"@acme.com')
    expect(decoded?.at).toBe("2026-09-17 14:32:05.123+00")
    expect(decoded?.id).toBe('"odd|name"@acme.com')
  })

  it("round-trips an id containing the separator", () => {
    const id = '"odd|name"@acme.com'
    const decoded = decodeCursor(encodeCursor("2026-09-17 14:32:05.123+00", id))
    expect(decoded?.id).toBe(id)
  })

  it("refuses a cursor it cannot parse rather than guessing", () => {
    // ⚠ EVERY ONE OF THESE MUST BE `null`, NOT A DATE OF `Invalid Date`. A
    // cursor is caller-supplied — it comes straight off the query string — and
    // an unparseable one that produced a NaN date would reach the query as
    // `created_at < NaN`, which matches nothing and renders an empty log for a
    // tenant whose mail is fine.
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor("")).toBeNull()
    expect(decodeCursor("not-a-cursor")).toBeNull()
    expect(decodeCursor("|abc")).toBeNull()
    expect(decodeCursor("2026-09-17 14:32:05.123+00|")).toBeNull()
    expect(decodeCursor("garbage|abc")).toBeNull()
    expect(decodeCursor("'; drop table core.messages; --|abc")).toBeNull()
  })

  /**
   * ⚠ THE SHAPE CHECK ALONE IS NOT ENOUGH, AND THIS IS THE TEST THAT SAYS SO.
   * `2026-13-45 99:99:99` matches the pattern, binds safely as a parameter, and
   * then raises `invalid input syntax for type timestamp` inside Postgres — a
   * 500 on a log page because somebody edited the URL.
   */
  it("refuses a well-shaped timestamp that is not a real instant", () => {
    expect(decodeCursor("2026-13-45 99:99:99+00|abc")).toBeNull()
    expect(decodeCursor("9999-99-99T99:99:99Z|abc")).toBeNull()
  })
})

describe("escapeLike", () => {
  /**
   * ⚠ THE BACKSLASH IS THE ONE THAT MATTERS, AND IT IS THE ONE PEOPLE FORGET.
   * Escaping only `%` and `_` leaves a search string able to neutralise the
   * escaping applied to the other two — `\%` arrives at Postgres as an escaped
   * escape followed by a live wildcard.
   */
  it("escapes all three LIKE metacharacters", () => {
    expect(escapeLike("50%")).toBe("50\\%")
    expect(escapeLike("a_b")).toBe("a\\_b")
    expect(escapeLike("back\\slash")).toBe("back\\\\slash")
  })

  it("escapes the backslash before it can protect a wildcard", () => {
    // `\%` must become `\\\%` — an escaped backslash, then an escaped percent.
    // If the backslash were left alone the result would be `\%`, which Postgres
    // reads as one escaped percent and the leading character disappears.
    expect(escapeLike("\\%")).toBe("\\\\\\%")
  })

  it("leaves ordinary text alone", () => {
    expect(escapeLike("bob@acme.com")).toBe("bob@acme.com")
    expect(escapeLike("Reset your password")).toBe("Reset your password")
  })
})

describe("clampLimit", () => {
  it("defaults when the caller says nothing", () => {
    expect(clampLimit(undefined)).toBe(50)
  })

  it("refuses a limit that would scan a partitioned table", () => {
    expect(clampLimit(1_000_000)).toBe(200)
  })

  it("refuses zero and negatives, which would return an empty page forever", () => {
    expect(clampLimit(0)).toBe(50)
    expect(clampLimit(-10)).toBe(1)
  })

  /**
   * ⚠ `Number("abc")` IS `NaN` AND `NaN` PASSES EVERY COMPARISON. A limit read
   * off a query string is a string; without the `isFinite` guard, `?limit=abc`
   * reaches `LIMIT NaN` and the query raises — a 500 on a log page because
   * somebody edited the URL.
   */
  it("falls back when the value is not a number", () => {
    expect(clampLimit(Number("abc"))).toBe(50)
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(50)
  })

  it("truncates a fractional limit rather than passing it through", () => {
    expect(clampLimit(10.7)).toBe(10)
  })
})
