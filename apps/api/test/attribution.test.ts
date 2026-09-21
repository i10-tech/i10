import { describe, expect, it, mock } from "bun:test"
import { attribute } from "../src/billing/attribution.js"

/**
 * ⚠ THESE PIN THE ORDER, WHICH IS THE ENTIRE DESIGN. Every attribution bug this
 * system has had came from asking Polar who owns a subscription. The answer now
 * comes from our own rows, and `external_id` is consulted last and only for
 * customers that predate `core.polar_checkouts`.
 */

const sub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  checkout_id: "chk_1",
  customer: { external_id: "ten-stale" },
  ...over,
})

const source = (over: Record<string, unknown> = {}) => ({
  ownerOf: async () => null,
  checkoutTenant: async () => null,
  ...over,
})

describe("attributing a Polar subscription", () => {
  // The steady state: every event after the first one.
  it("prefers the tenant already holding the subscription", async () => {
    const checkoutTenant = mock(async () => "ten-checkout")
    const got = await attribute(
      sub(),
      source({ ownerOf: async () => "ten-holder", checkoutTenant }),
    )

    expect(got).toEqual({ tenantId: "ten-holder", via: "holder" })
    // ⚠ AND IT DOES NOT ASK FURTHER. The binding is the fact; a second lookup
    // could only introduce a way to disagree with it.
    expect(checkoutTenant).not.toHaveBeenCalled()
  })

  // The first event for a new subscription — the case that used to need
  // `external_id` and is the reason this module exists.
  it("falls back to the checkout that bought it", async () => {
    const got = await attribute(
      sub(),
      source({ checkoutTenant: async () => "ten-checkout" }),
    )

    expect(got).toEqual({ tenantId: "ten-checkout", via: "checkout" })
  })

  /*
   * ⚠ THE LEGACY LEG, AND IT MUST STAY LAST. Customers created before
   * `core.polar_checkouts` have no checkout row, and their `external_id` is the
   * only thing naming a tenant — but it is also the field that goes stale on a
   * re-signup and cannot be corrected, so anything we know ourselves beats it.
   */
  it("uses external_id only when nothing of ours knows the subscription", async () => {
    const got = await attribute(sub(), source())
    expect(got).toEqual({ tenantId: "ten-stale", via: "external_id" })
  })

  it("does not reach for external_id when a checkout row exists", async () => {
    const got = await attribute(
      sub({ customer: { external_id: "ten-stale" } }),
      source({ checkoutTenant: async () => "ten-checkout" }),
    )

    expect(got?.tenantId).toBe("ten-checkout")
  })

  // A subscription created outside a checkout, for a customer with no id: real
  // money from somebody we cannot name. The caller must strand it, not guess.
  it("gives up rather than guessing", async () => {
    const got = await attribute(
      sub({ checkout_id: null, customer: { external_id: null } }),
      source(),
    )

    expect(got).toBeNull()
  })

  // ⚠ A MISSING `checkout_id` MUST NOT BE LOOKED UP. Asking for the tenant of
  // `null` is a query that can only ever return nothing, once per subscription.
  it("skips the checkout lookup when there is no checkout", async () => {
    const checkoutTenant = mock(async () => null)
    await attribute(sub({ checkout_id: null }), source({ checkoutTenant }))

    expect(checkoutTenant).not.toHaveBeenCalled()
  })
})
