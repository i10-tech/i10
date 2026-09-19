import { describe, expect, it } from "bun:test"
import { polarClient } from "../src/billing/polar.js"

/**
 * Reading a checkout back by id.
 *
 * ⚠ THE DISTINCTION UNDER TEST IS "NO SUCH CHECKOUT" VERSUS "POLAR IS DOWN",
 * AND GETTING IT WRONG WAS VISIBLE IN THE PRODUCT. The id reaches this call from
 * a browser, so a value Polar refuses is the ordinary case — and the route above
 * turns a THROWN error into a 503 reading "Could not reach the payment
 * provider", which tells somebody mid-purchase that a payment system is down
 * when it in fact answered immediately and correctly.
 */
const client = (status: number, body: unknown = {}) =>
  polarClient({
    /*
     * ⚠ NOT SHAPED LIKE A TOKEN AT ALL. `fetch` is stubbed two lines down, so
     * this never leaves the process and its format is irrelevant to everything
     * being tested. It read `polar_` + a short suffix first, which was worse
     * than useless: that is not the prefix Polar actually issues (see
     * POLAR_ACCESS_TOKEN in src/env.ts), so it taught a reader a wrong fact
     * while looking enough like a credential to be worth a second glance.
     */
    accessToken: "stub-token-never-sent",
    server: "sandbox",
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })

describe("reading a Polar checkout by id", () => {
  it("returns the checkout with the tenant lifted out of its metadata", async () => {
    const found = await client(200, {
      id: "21ae5db2-5eec-465e-95e7-59ecd3155c72",
      status: "succeeded",
      metadata: { tenant_id: "ten-1" },
    }).getCheckout("21ae5db2-5eec-465e-95e7-59ecd3155c72")

    expect(found).toEqual({
      id: "21ae5db2-5eec-465e-95e7-59ecd3155c72",
      status: "succeeded",
      tenantId: "ten-1",
      customerId: null,
    })
  })

  it("answers null for an id Polar has never issued", async () => {
    expect(await client(404).getCheckout("cc7f0f70-0000-0000-0000-000000000000")).toBe(
      null,
    )
  })

  /*
   * ⚠ THIS IS THE REGRESSION. Polar validates the id before it looks anything
   * up, so a well-formed UUID that is not one of theirs comes back 422 rather
   * than 404 — measured against their sandbox with an all-zeros UUID, which the
   * console's own proxy happily forwards because it only checks the shape. That
   * fell through to the throw and surfaced as a 503.
   */
  it("answers null for a well-formed id Polar rejects as unprocessable", async () => {
    expect(await client(422).getCheckout("00000000-0000-0000-0000-000000000000")).toBe(
      null,
    )
  })

  /*
   * ⚠ AND EVERYTHING ELSE MUST STILL THROW, which is the half that makes the
   * two cases above worth distinguishing. A 401 means our token is wrong and a
   * 500 means Polar is broken; answering "no such checkout" to either would tell
   * somebody who has just paid that their checkout does not exist.
   */
  it.each([401, 403, 429, 500, 503])(
    "throws on %i rather than inventing an answer",
    async (status) => {
      expect(
        client(status).getCheckout("21ae5db2-5eec-465e-95e7-59ecd3155c72"),
      ).rejects.toThrow(`polar checkouts.get failed with ${status}`)
    },
  )
})

/**
 * Reading the customer a checkout resolved to.
 *
 * ⚠ ONE FIELD DECIDES WHETHER A PAYMENT EVER REACHES US. Every subscription
 * event is attributed by `customer.external_id`; Polar sets it only on a
 * customer it CREATES from a checkout's `external_customer_id`, and leaves it
 * alone on one that already existed. So this is the difference between "the
 * webhook is a second behind" and "nothing will ever grant this plan".
 */
describe("reading a Polar customer by id", () => {
  it("lifts out the external id Polar holds for them", async () => {
    expect(
      await client(200, { id: "cus_1", external_id: "ten-1" }).getCustomer("cus_1"),
    ).toEqual({ id: "cus_1", externalId: "ten-1" })
  })

  // ⚠ ABSENT AND NULL ARE THE SAME ANSWER, and it is the answer that matters:
  // a customer carrying no external id is one whose events are discarded.
  it("reports a customer with no external id as null rather than undefined", async () => {
    expect(await client(200, { id: "cus_1" }).getCustomer("cus_1")).toEqual({
      id: "cus_1",
      externalId: null,
    })
  })

  it.each([404, 422])("answers null for an id Polar refuses (%i)", async (status) => {
    expect(await client(status).getCustomer("cus_1")).toBe(null)
  })

  it.each([401, 403, 500])(
    "throws on %i rather than inventing an answer",
    async (status) => {
      expect(client(status).getCustomer("cus_1")).rejects.toThrow(
        `polar customers.get failed with ${status}`,
      )
    },
  )
})
