import type { PolarSubscription } from "./events.js"

/**
 * Deciding which workspace a Polar subscription belongs to.
 *
 * ⚠ THIS IS THE ANSWER TO THE BUG CLASS THAT KEPT COMING BACK, and the fix is
 * not a better heuristic — it is moving workspace identity OUT OF POLAR. The
 * original design put a TENANT id into `external_customer_id`, which Polar
 * stores on the CUSTOMER: a record it scopes to a person, deduplicates by
 * EMAIL, stamps only at creation, and refuses to update ever after (measured:
 * `422 Customer external ID cannot be updated`).
 *
 * A workspace and a person do not have the same lifetime. Delete the workspace
 * and the person remains; sign up again and Polar hands back the same customer,
 * still naming a workspace that is gone — permanently, with no repair possible
 * from either side. Every symptom traced back to that one mismatch: the
 * cancellation that 500'd for ever, the reconciler that called it `contested`
 * and skipped it, the confirmation page that said "unattributed" to somebody who
 * had just paid.
 *
 * ⚠ SO NOTHING HERE ASKS POLAR WHO OWNS A SUBSCRIPTION. Both authoritative
 * answers are rows in our own database, written by us, from authenticated
 * sessions, unreachable from Polar's dashboard or anybody's API token.
 */

/** The two questions attribution asks of our own tables. */
export interface AttributionSource {
  /** The tenant already holding this subscription id, from `core.subscriptions`. */
  ownerOf(polarSubscriptionId: string): Promise<string | null>
  /** The tenant a checkout was started for, from `core.polar_checkouts`. */
  checkoutTenant(polarCheckoutId: string): Promise<string | null>
}

export type AttributionVia = "holder" | "checkout" | "external_id"

export interface Attributed {
  tenantId: string
  via: AttributionVia
}

/**
 * ⚠ THE ORDER IS THE DESIGN, AND EACH STEP OUTRANKS THE ONE BELOW IT.
 *
 *   1. `holder`      — our subscription row. Once a subscription is bound, that
 *                      binding is the fact; it was written from a checkout we
 *                      created, and Polar has nothing better to say about it.
 *                      Checking it first is also what makes every event after
 *                      the first one cost one indexed lookup and no ambiguity.
 *
 *   2. `checkout`     — `core.polar_checkouts`, written before the customer was
 *                      redirected to pay. This is how a subscription is bound
 *                      the FIRST time, and it is why nothing has to be
 *                      round-tripped through Polar to attribute a payment.
 *
 *   3. `external_id`  — the legacy field, and ONLY as a fallback for customers
 *                      created before this existed. It is immutable and goes
 *                      stale on a re-signup, so it can be wrong; it is last
 *                      precisely because the two above cannot be.
 *
 * `null` means nobody can be identified — real money from somebody we cannot
 * name — and callers must treat it as `stranded` rather than guessing.
 */
export async function attribute(
  sub: Pick<PolarSubscription, "id" | "checkout_id" | "customer">,
  source: AttributionSource,
): Promise<Attributed | null> {
  const holder = await source.ownerOf(sub.id)
  if (holder) return { tenantId: holder, via: "holder" }

  if (sub.checkout_id) {
    const fromCheckout = await source.checkoutTenant(sub.checkout_id)
    if (fromCheckout) return { tenantId: fromCheckout, via: "checkout" }
  }

  const legacy = sub.customer?.external_id
  if (legacy) return { tenantId: legacy, via: "external_id" }

  return null
}
