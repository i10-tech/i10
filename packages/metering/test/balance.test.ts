import { describe, expect, it } from "bun:test"
import { draw, remainingOf } from "../src/balance.js"

describe("drawing down", () => {
  it("allows a request that fits and reports what is left", () => {
    expect(draw({ allowance: 100, used: 30, requested: 20 })).toEqual({
      status: "allowed",
      remaining: 50,
    })
  })

  it("allows a request that exactly exhausts the allowance", () => {
    expect(draw({ allowance: 100, used: 90, requested: 10 })).toEqual({
      status: "allowed",
      remaining: 0,
    })
  })

  it("refuses one unit past the allowance", () => {
    expect(draw({ allowance: 100, used: 100, requested: 1 })).toEqual({
      status: "exceeded",
      remaining: 0,
      shortfall: 1,
    })
  })

  /**
   * ⚠ ALL-OR-NOTHING, NEVER PARTIAL. Trimming a batch would mean answering one
   * `POST /emails` with "some of these were accepted" and leaving the caller to
   * work out which recipients were dropped — a quota error turned into silent
   * data loss.
   */
  it("refuses a batch outright rather than trimming it", () => {
    expect(draw({ allowance: 1000, used: 700, requested: 500 })).toEqual({
      status: "exceeded",
      remaining: 300,
      shortfall: 200,
    })
  })
})

describe("overdraft", () => {
  /**
   * ⚠ THE GATE IS APPROXIMATE, SO THIS STATE IS REACHABLE AND IS NOT AN ERROR.
   * A burst racing a stale read, or an unevenly drained shard, both arrive here
   * as `used` past the allowance.
   */
  it("accepts that used may exceed the allowance", () => {
    expect(draw({ allowance: 100, used: 140, requested: 1 })).toEqual({
      status: "exceeded",
      remaining: 0,
      shortfall: 1,
    })
  })

  // ⚠ A NEGATIVE REMAINING REACHES CUSTOMERS — a rate-limit header, a usage
  // dashboard — and reads as our bug rather than as a tolerated overdraft.
  it("never reports a negative remaining", () => {
    expect(remainingOf({ allowance: 100, used: 140 })).toBe(0)
  })
})

describe("unlimited", () => {
  // ⚠ A DISTINCT VALUE, NOT A LARGE NUMBER. Sentinels survive until someone
  // writes them to a column or renders them on a dashboard.
  it("allows any request", () => {
    const outcome = draw({ allowance: "unlimited", used: 10_000_000, requested: 500 })
    expect(outcome.status).toBe("allowed")
    expect(outcome.remaining).toBe(Number.POSITIVE_INFINITY)
  })

  it("reports an infinite remaining", () => {
    expect(remainingOf({ allowance: "unlimited", used: 5 })).toBe(
      Number.POSITIVE_INFINITY,
    )
  })
})

describe("a request for nothing", () => {
  // Not a send, so refusing it would report a quota error for an operation that
  // consumes no quota.
  it("is allowed even when the tenant is already over", () => {
    expect(draw({ allowance: 100, used: 250, requested: 0 })).toEqual({
      status: "allowed",
      remaining: 0,
    })
  })
})

describe("refusals", () => {
  it("refuses a negative or non-finite request rather than treating it as a credit", () => {
    for (const requested of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => draw({ allowance: 100, used: 0, requested })).toThrow(RangeError)
    }
  })

  it("refuses a negative allowance", () => {
    expect(() => draw({ allowance: -5, used: 0, requested: 1 })).toThrow(RangeError)
  })
})

/**
 * ⚠ ACCEPTED WHOLE, ATTRIBUTED IN TWO PARTS. This is NOT the partial acceptance
 * refused above — the batch still goes in full. What splits is which units are
 * covered by the plan and which land on an invoice.
 */
describe("overage", () => {
  it("splits a batch that crosses the line, without trimming it", () => {
    expect(draw({ allowance: 1000, used: 700, requested: 500, overage: true })).toEqual(
      { status: "overage", remaining: 0, included: 300, billable: 200 },
    )
  })

  it("bills the whole request once the allowance is already spent", () => {
    expect(draw({ allowance: 100, used: 100, requested: 5, overage: true })).toEqual({
      status: "overage",
      remaining: 0,
      included: 0,
      billable: 5,
    })
  })

  it("stays `allowed` while the request still fits", () => {
    expect(draw({ allowance: 100, used: 10, requested: 5, overage: true })).toEqual({
      status: "allowed",
      remaining: 85,
    })
  })

  // ⚠ THE DEFAULT IS A HARD CAP. A caller that forgets the flag gets a refusal,
  // never a surprise invoice — the safe direction for the customer.
  it("refuses rather than bills when the flag is absent", () => {
    expect(draw({ allowance: 100, used: 100, requested: 5 })).toEqual({
      status: "exceeded",
      remaining: 0,
      shortfall: 5,
    })
  })

  /**
   * ⚠ AN OVERDRAFT IS STILL BILLED FROM ZERO, NOT FROM THE NEGATIVE. `used` past
   * the allowance is a tolerated state of an approximate gate; billing the gap
   * as well would charge the customer for our imprecision twice.
   */
  it("bills only this request when used is already past the allowance", () => {
    expect(draw({ allowance: 100, used: 140, requested: 10, overage: true })).toEqual({
      status: "overage",
      remaining: 0,
      included: 0,
      billable: 10,
    })
  })

  // ⚠ There is no allowance to be past, so there is nothing to bill — an
  // unlimited feature producing billable units is a contradiction on an invoice.
  it("never bills an unlimited allowance", () => {
    expect(
      draw({ allowance: "unlimited", used: 10_000, requested: 5, overage: true })
        .status,
    ).toBe("allowed")
  })

  it("still allows a request for nothing", () => {
    expect(draw({ allowance: 100, used: 250, requested: 0, overage: true })).toEqual({
      status: "allowed",
      remaining: 0,
    })
  })
})
