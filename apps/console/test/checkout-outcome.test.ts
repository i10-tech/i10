import { describe, expect, it } from "bun:test"
import { isStatus, keepPolling, present, type Result } from "../lib/checkout-outcome"

/**
 * What the page says after a checkout.
 *
 * ⚠ THESE WERE UNREACHABLE WITHOUT A POLAR ACCOUNT AND A DECLINED CARD, which
 * is why "the redirect shows nothing" survived as long as it did. Success had a
 * banner; failure, abandonment and the in-flight second had none, because the
 * only way to arrive at this component was Polar's redirect — and nobody is
 * redirected for changing their mind. The console now reports the outcome of a
 * checkout it closed itself, so all of them are reachable and all of them have
 * to be right.
 */

const result = (over: Partial<Result> = {}): Result => ({
  status: "paid",
  plan: null,
  ...over,
})

describe("what the customer is told", () => {
  it("names the plan they actually bought once it is granted", () => {
    expect(present(result({ status: "granted", plan: "Pro" }), false)).toMatchObject({
      tone: "success",
      title: "You're on Pro",
    })
  })

  // ⚠ NOT "You're on Pro" TO SOMEBODY WHO BOUGHT SOMETHING ELSE. Hardcoding the
  // plan congratulated every customer on a subscription they may not hold.
  it("stays vague when the grant landed without a plan name", () => {
    expect(present(result({ status: "granted" }), false)).toMatchObject({
      tone: "success",
      title: "You're all set",
    })
  })

  it("says the money arrived while the entitlement is still landing", () => {
    expect(present(result({ status: "paid" }), false)).toMatchObject({
      tone: "waiting",
      title: "Payment received",
    })
  })

  /*
   * ⚠ CLOSING A CHECKOUT IS NOT A FAILURE, AND THIS IS THE COMMON CASE NOW. The
   * modal's ✕ lands here; painting it red would tell somebody who simply
   * changed their mind that something went wrong.
   */
  it("treats a closed checkout as ordinary, not as an error", () => {
    const view = present(result({ status: "unpaid", detail: "open" }), false)
    expect(view.tone).not.toBe("failed")
    expect(view.title).toBe("Checkout closed")
    expect(view.body).toContain("Nothing was charged")
  })

  // ⚠ AND A CHARGE IN FLIGHT IS NOT A FAILURE EITHER. Polar sets `confirmed`
  // between submission and settlement; "not completed" there is a lie that
  // corrects itself seconds later, after the customer has read it.
  it("does not call an in-flight charge a failure", () => {
    expect(
      present(result({ status: "unpaid", detail: "confirmed" }), false),
    ).toMatchObject({ tone: "waiting", title: "Processing your payment" })
  })

  it("says a declined card was not charged, and suggests another", () => {
    const view = present(result({ status: "unpaid", detail: "failed" }), false)
    expect(view.tone).toBe("failed")
    expect(view.body).toContain("not charged")
    expect(view.body).toContain("different card")
  })

  it("tells an expired checkout apart from a refused one", () => {
    expect(
      present(result({ status: "unpaid", detail: "expired" }), false),
    ).toMatchObject({ tone: "failed", title: "This checkout expired" })
  })

  /*
   * ⚠ THE ONE PAID STATE THAT IS A DEAD END. The API tries to repair
   * attribution itself — including reclaiming a Polar customer left behind by a
   * deleted workspace — so reaching here means a human is needed, and the copy
   * must not promise a repair that cannot happen.
   */
  it("does not promise a repair for a payment nothing can attribute", () => {
    const view = present(result({ status: "paid", detail: "unattributed" }), false)
    expect(view.tone).toBe("failed")
    expect(view.body).toContain("support@i10.tech")
  })

  // ⚠ THE CEILING HAS TO HAVE SOMEWHERE TO SHOW ITSELF. Without this branch a
  // status endpoint that never answered usefully left a spinner up for ever.
  it("gives up honestly rather than spinning", () => {
    expect(present(null, true)).toMatchObject({
      tone: "waiting",
      title: "This is taking longer than usual",
    })
  })

  // ⚠ AND IT NO LONGER QUOTES THE RECONCILER'S SCHEDULE AT A CUSTOMER. The
  // status endpoint grants from Polar's own answer now, so "we check every half
  // hour" described a wait that no longer exists.
  it("no longer sends anybody away for half an hour", () => {
    for (const view of [
      present(null, true),
      present(result({ status: "paid" }), true),
    ]) {
      expect(view.body).not.toContain("half hour")
    }
  })
})

describe("whether to keep asking", () => {
  // The three states that are still moving. Missing any of them freezes the
  // page on a sentence that is about to stop being true.
  it.each([
    ["the money has landed and the plan has not", result({ status: "paid" })],
    ["our own API is unreachable", result({ status: "unavailable" })],
    ["the charge is in flight", result({ status: "unpaid", detail: "confirmed" })],
  ])("keeps polling while %s", (_why, body) => {
    expect(keepPolling(body)).toBe(true)
  })

  it.each([
    ["granted", result({ status: "granted", plan: "Pro" })],
    ["declined", result({ status: "unpaid", detail: "failed" })],
    ["expired", result({ status: "unpaid", detail: "expired" })],
    ["closed", result({ status: "unpaid", detail: "open" })],
    ["unknown", result({ status: "unknown" })],
  ])("stops once the answer is %s", (_what, body) => {
    expect(keepPolling(body)).toBe(false)
  })

  /*
   * ⚠ `unattributed` IS AN ENDING DESPITE BEING `paid`, and it is the one
   * exception that has to be stated. Everything else about it says "keep
   * waiting"; nothing further is coming.
   */
  it("stops on a payment nothing can attribute, though it is `paid`", () => {
    expect(keepPolling(result({ status: "paid", detail: "unattributed" }))).toBe(false)
  })
})

/*
 * ⚠ THE GUARD THAT BROKE THIS ONCE. The proxy answers the API's own error shape
 * verbatim — `{ statusCode, name, message }` with no `status` at all — and
 * casting that to a result made the poll STOP on a body that said nothing, and
 * render "we could not find that checkout" to somebody who had paid.
 */
describe("a body that is not an answer", () => {
  it.each([[undefined], [null], [""], ["succeeded"], [{ statusCode: 502 }], [503]])(
    "is not mistaken for a status: %p",
    (value) => {
      expect(isStatus(value)).toBe(false)
    },
  )

  it.each(["granted", "paid", "unpaid", "unknown", "unavailable"])(
    "accepts %s",
    (value) => {
      expect(isStatus(value)).toBe(true)
    },
  )
})
