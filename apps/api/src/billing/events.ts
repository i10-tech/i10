/**
 * What a Polar event means for entitlement.
 *
 * ⚠ THE DECISION IS MADE FROM `data.status`, NOT FROM THE EVENT NAME. Polar has
 * eleven subscription events and adds more; switching on the name means a new
 * one is silently ignored, and `subscription.created` in particular is NOT
 * proof of payment — it can describe a subscription that is `incomplete` and
 * never pays. The status field is the thing Polar actually maintains, so it is
 * what this reads, and an event type we have never seen still lands on the
 * right side of the line.
 *
 * ⚠ `canceled` IS NOT `revoked`, AND CONFUSING THEM TAKES AWAY ACCESS SOMEBODY
 * PAID FOR. `subscription.canceled` fires the moment a customer clicks cancel:
 * the status stays `active` with `cancel_at_period_end` set, and they keep what
 * they bought until the period ends. Only `revoked` — status `canceled` — ends
 * it. So `cancelAtPeriodEnd` is recorded and deliberately not acted on.
 *
 * ⚠ BUT A CANCELLATION'S OWN DEADLINE IS ENFORCED WITHOUT WAITING TO BE TOLD.
 * Once `cancel_at_period_end` is set, Polar has stated the end date, and after
 * that date passes the subscription entitles nothing — whether or not the
 * `revoked` event announcing it ever arrives. Reading it that way is what makes
 * the end date the end date: the alternative is that a lost webhook silently
 * becomes an open-ended free extension, granted by nobody and noticed by no
 * one, because every other check we have would agree the row looks fine.
 *
 * ⚠ AND IT IS SCOPED TO `cancel_at_period_end`, WHICH IS NOT PEDANTRY. A
 * renewing subscription is past its `current_period_end` for the moment
 * between the period elapsing and Polar's renewal landing; expiring on the
 * date alone would cut off a paying customer once a month, every month, for as
 * long as that gap lasts. Only a subscription Polar has already said will not
 * renew can be ended by its own clock.
 *
 * ⚠ AND `past_due` KEEPS ITS ENTITLEMENT ON PURPOSE. A card that failed at
 * 3am is not a customer who stopped paying; Polar retries for days and revokes
 * when it gives up. Cutting transactional email off at the first failed charge
 * means a company's password resets stop because their card expired, which is
 * a support incident that starts as a trust problem.
 */

/** Polar's subscription statuses, as its API documents them. */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"])

export interface PolarSubscription {
  id: string
  status: string
  product_id: string
  customer_id: string
  customer?: { external_id?: string | null } | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean | null
  modified_at?: string | null
  created_at?: string | null
}

export interface PolarEvent {
  type: string
  data: PolarSubscription
}

/** The row a subscription event asks us to write, and the plan it implies. */
export interface SubscriptionState {
  tenantId: string
  polarSubscriptionId: string
  polarCustomerId: string
  polarProductId: string
  /** Our plan id, from the product map. What they bought. */
  planId: string
  /** Polar's status verbatim — see the note on the column. */
  status: string
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
  /**
   * ⚠ THE MONOTONIC GUARD, AND IT IS POLAR'S CLOCK RATHER THAN OURS. Webhooks
   * retry and arrive out of order: a delayed `active` landing after `revoked`
   * would re-grant Pro to a customer who churned. Ordering on receipt time
   * cannot see that; ordering on the subscription's own `modified_at` can.
   */
  eventAt: Date
  /**
   * The plan the customer should hold RIGHT NOW — `planId` while the
   * subscription entitles them, the free plan once it does not. This is what
   * gets attached, and keeping it separate from `planId` is what lets
   * the row still say what they bought after access ends.
   */
  entitledPlanId: string
}

export type Decision =
  { kind: "apply"; state: SubscriptionState } | { kind: "ignore"; reason: string }

export interface DecideOptions {
  /** Polar product id → our plan id. From POLAR_PRODUCTS. */
  planForProduct: (productId: string) => string | undefined
  freePlanId: string
  /**
   * ⚠ THE CLOCK IS AN INPUT BECAUSE ENTITLEMENT NOW DEPENDS ON IT. A cancelled
   * subscription's answer changes from `pro` to `free` with nothing but time
   * passing, so a test that could not move the clock could only assert the
   * boring half of the rule. Optional, so no production call site has to pass
   * it and none of them can drift.
   */
  now?: () => Date
}

/**
 * ⚠ RETURNS `ignore` RATHER THAN THROWING FOR EVERYTHING WE CANNOT ACT ON, and
 * the route answers 2xx to those. Polar retries a non-2xx for hours; an
 * `order.paid` we have no use for would be retried all afternoon, and a
 * subscription for a product we do not recognise would be retried forever.
 * Neither is a failure — they are events that are not ours.
 */
export function decide(event: PolarEvent, opts: DecideOptions): Decision {
  if (!event.type.startsWith("subscription.")) {
    return { kind: "ignore", reason: `not a subscription event (${event.type})` }
  }

  return toState(event.data, opts)
}

/**
 * The same judgement, applied to a subscription read back from Polar's API
 * rather than pushed to us.
 *
 * ⚠ ONE FUNCTION FOR BOTH DIRECTIONS, ON PURPOSE. The reconciler exists to
 * catch what the webhook path missed; if it decided entitlement by its own
 * slightly different rules, the two would disagree on edge cases — a trialing
 * customer, a `past_due` one — and the disagreement would present as the
 * reconciler flipping a plan back and forth on every run.
 */
export function toState(
  sub: PolarSubscription | undefined,
  opts: DecideOptions,
): Decision {
  if (!sub || typeof sub.id !== "string" || typeof sub.status !== "string") {
    return { kind: "ignore", reason: "payload is not a subscription" }
  }

  // ⚠ THE TENANT COMES FROM `external_customer_id`, WHICH WE SET AT CHECKOUT.
  // Not from the email — a customer can change that mid-checkout, and matching
  // on it would attach a plan to whoever else happens to own the address.
  const tenantId = sub.customer?.external_id ?? undefined
  if (!tenantId) {
    return {
      kind: "ignore",
      reason: `subscription ${sub.id} has no external customer id`,
    }
  }

  const planId = opts.planForProduct(sub.product_id)
  if (!planId) {
    // Somebody bought something in the same Polar organisation that is not an
    // i10 plan. Not an error, and definitely not a retry.
    return { kind: "ignore", reason: `product ${sub.product_id} is not an i10 plan` }
  }

  const currentPeriodEnd = parseDate(sub.current_period_end)
  const cancelAtPeriodEnd = sub.cancel_at_period_end ?? false

  // The period a cancelled subscription was paid up to, once it is behind us.
  // `null` current_period_end means Polar has not stated one, which is not the
  // same as one that has passed.
  const lapsed =
    cancelAtPeriodEnd &&
    currentPeriodEnd !== null &&
    currentPeriodEnd.getTime() <= (opts.now?.() ?? new Date()).getTime()

  const entitled = ENTITLED_STATUSES.has(sub.status) && !lapsed

  return {
    kind: "apply",
    state: {
      tenantId,
      polarSubscriptionId: sub.id,
      polarCustomerId: sub.customer_id,
      polarProductId: sub.product_id,
      planId,
      status: sub.status,
      cancelAtPeriodEnd,
      currentPeriodEnd,
      // `modified_at` is null on an object that has never been modified, so
      // `created_at` is the fallback rather than `now()` — using our own clock
      // would make two events that arrive together unorderable.
      eventAt: parseDate(sub.modified_at) ?? parseDate(sub.created_at) ?? new Date(),
      entitledPlanId: entitled ? planId : opts.freePlanId,
    },
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}
