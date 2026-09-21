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
  /**
   * The checkout that bought this subscription.
   *
   * ⚠ IT IS THE ONLY FIELD ON A SUBSCRIPTION THAT NAMES A WORKSPACE, and it
   * does so indirectly and reliably. We create the checkout, so
   * `core.polar_checkouts` holds the tenant it was started for — written
   * before the redirect, from an authenticated session, unreachable from
   * Polar's side. `customer.external_id` cannot do this job: it is scoped to
   * the PERSON, deduplicated by email, and immutable once set.
   */
  checkout_id?: string | null
  customer?: { external_id?: string | null } | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean | null
  modified_at?: string | null
  created_at?: string | null
  /**
   * A change Polar has accepted and will apply at the next period boundary.
   *
   * ⚠ THIS IS WHAT A DOWNGRADE LOOKS LIKE FOR THE REST OF THE MONTH, AND
   * READING IT IS THE ONLY WAY TO KNOW ONE HAPPENED. `prorationFor("downgrade")`
   * asks for `next_period` precisely so the customer keeps what they paid for —
   * and the consequence is that `product_id` above still names the OLD plan
   * until the boundary passes. Everything else we store would say nothing had
   * changed.
   *
   * ⚠ AND IT IS READ, NEVER ACTED ON. `applies_at` is in the future by
   * definition; entitling the new product now would take away the allowance
   * they are still paying for, which is the exact failure deferring the change
   * exists to avoid.
   */
  pending_update?: {
    product_id?: string | null
    applies_at?: string | null
  } | null
}

export interface PolarEvent {
  type: string
  data: PolarSubscription
}

/** The row a subscription event asks us to write, and the plan it implies. */
export interface SubscriptionState {
  tenantId: string
  polarSubscriptionId: string
  /**
   * The checkout this subscription came from, for attribution. `null` on one
   * created any other way, or predating the field.
   */
  checkoutId: string | null
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
  /**
   * The plan a deferred change will move them to, and when. Both null when
   * nothing is scheduled, which is the ordinary case.
   *
   * ⚠ IT IS NOT AN ENTITLEMENT AND MUST NEVER BE READ AS ONE. See
   * `pending_update` above: this describes a future, and the customer holds
   * `entitledPlanId` until it arrives.
   */
  scheduledPlanId: string | null
  scheduledAt: Date | null
}

export type Decision =
  | { kind: "apply"; state: SubscriptionState }
  | {
      kind: "ignore"
      reason: string
      /**
       * A real subscription we could not attribute to anybody.
       *
       * ⚠ IT SEPARATES THE ONE IGNORE THAT COSTS MONEY FROM THE THREE THAT DO
       * NOT, AND WITHOUT IT ALL FOUR WERE ONE `info` LINE. An order event, a
       * benefit, a product somebody else sells in the same Polar organisation
       * — those are genuinely not ours and logging them loudly would train
       * everybody to ignore the log. A subscription whose customer carries no
       * `external_id` is the opposite: somebody has paid, Polar shows them as
       * active, and this is the exact moment we decide to do nothing about it
       * — permanently, because the reconciler drops it by the identical rule.
       */
      stranded?: boolean
    }

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
export function decide(
  event: PolarEvent,
  opts: DecideOptions,
  /**
   * The tenant this subscription belongs to, resolved from our own tables.
   *
   * ⚠ THIS PARAMETER USED TO BE WITHHELD FROM THIS PATH ON PURPOSE, AND THE
   * REASON IT IS NOW PASSED IS THE OPPOSITE OF A RELAXATION. The old rule was
   * "the webhook attributes by `external_id` and may not override it", which
   * protected against attribution from a weaker source. `billing/attribution.ts`
   * is a STRONGER source than the field it replaces: the subscription row we
   * already hold, then the checkout row we wrote before the customer was
   * redirected. Both are ours; `external_id` is Polar's, immutable, and stale
   * the moment somebody re-signs up.
   *
   * ⚠ AND IT IS STILL NOT SOMETHING THE PAYLOAD CAN CHOOSE. The caller resolves
   * it from the database using the subscription and checkout ids; nothing a
   * sender puts in the body reaches this argument.
   */
  attributeTo?: string,
): Decision {
  if (!event.type.startsWith("subscription.")) {
    return { kind: "ignore", reason: `not a subscription event (${event.type})` }
  }

  return toState(event.data, opts, attributeTo)
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
  /**
   * The tenant to attribute this subscription to, overriding
   * `customer.external_id`.
   *
   * ⚠ ONLY EVER THE TENANT ON A SUCCEEDED CHECKOUT, AND THAT IS A STRONGER
   * ATTRIBUTION THAN THE FIELD IT OVERRIDES — not a weaker one. `external_id`
   * is stamped by Polar ONCE, when it creates a customer from a checkout's
   * `external_customer_id`, and is never maintained afterwards. Polar
   * deduplicates customers by EMAIL, so every later purchase by the same person
   * — a new workspace, a re-signup after deleting an account — reuses that
   * customer and inherits an id naming whoever bought FIRST. Observed in
   * production 2026-09-20: seven subscriptions on one customer, all seven
   * carrying a tenant that no longer existed, including one created thirty
   * seconds after the checkout being answered.
   *
   * `metadata.tenant_id` on the checkout is the opposite: OUR API writes it at
   * creation, from an authenticated session, and Polar echoes it back
   * unchanged. Combined with `status === "succeeded"` — Polar's own word that
   * the money moved for THIS checkout — it says exactly who paid for what.
   *
   * ⚠ IT IS A PARAMETER RATHER THAN A FIELD ON `DecideOptions` SO THE WEBHOOK
   * CANNOT REACH IT. That path has no checkout and no business overriding
   * anything; `decide` does not pass it and cannot.
   */
  attributeTo?: string,
): Decision {
  if (!sub || typeof sub.id !== "string" || typeof sub.status !== "string") {
    return { kind: "ignore", reason: "payload is not a subscription" }
  }

  // ⚠ THE TENANT COMES FROM `external_customer_id`, WHICH WE SET AT CHECKOUT.
  // Not from the email — a customer can change that mid-checkout, and matching
  // on it would attach a plan to whoever else happens to own the address.
  const tenantId = attributeTo ?? sub.customer?.external_id ?? undefined
  if (!tenantId) {
    /*
     * ⚠ THIS IS NOT A MALFORMED PAYLOAD, AND TREATING IT AS ONE IS WHY IT WENT
     * UNNOTICED. Polar sets `external_id` on a customer it CREATES from a
     * checkout's `external_customer_id` — their field documentation says so in
     * as many words — and leaves it alone on a customer that already existed.
     * So a tenant whose Polar customer was made any other way pays, subscribes,
     * and is dropped here on every event for ever.
     */
    /*
     * ⚠ AND IT IS ONLY `stranded` WHILE IT STILL ENTITLES SOMETHING. What makes
     * this worth shouting about is that somebody has PAID and Polar shows them
     * as active while nothing here will ever grant it. A subscription that has
     * ended is none of that: no money is moving, and there is nothing to grant
     * even if we could name the payer.
     *
     * ⚠ AND POLAR NEVER DELETES A SUBSCRIPTION, so without this the list only
     * grows. Deleting a customer soft-deletes it and its `external_id` stops
     * resolving — so every cancelled subscription it ever had becomes
     * permanently unattributable, is reported on every run, and the job can
     * never be green again. Measured after flushing the sandbox organisation:
     * 31 cancelled subscriptions, 31 `stranded`, exit 1, for ever.
     */
    if (!ENTITLED_STATUSES.has(sub.status)) {
      return {
        kind: "ignore",
        reason: `ended subscription ${sub.id} has no external customer id`,
      }
    }

    return {
      kind: "ignore",
      reason: `subscription ${sub.id} has no external customer id (customer ${sub.customer_id})`,
      stranded: true,
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

  // ⚠ A PENDING CHANGE TO A PRODUCT WE DO NOT SELL IS RECORDED AS NO CHANGE,
  // NOT AS A FAILURE. It is the same judgement `planForProduct` already makes
  // about the live product, and the stake is lower: the worst case is a console
  // that does not mention a scheduled move, rather than an event retried for
  // hours over a field nothing acts on.
  const scheduledPlanId = sub.pending_update?.product_id
    ? (opts.planForProduct(sub.pending_update.product_id) ?? null)
    : null

  return {
    kind: "apply",
    state: {
      tenantId,
      scheduledPlanId,
      scheduledAt: scheduledPlanId ? parseDate(sub.pending_update?.applies_at) : null,
      polarSubscriptionId: sub.id,
      checkoutId: sub.checkout_id ?? null,
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

/**
 * Which of two subscriptions for the same tenant states their entitlement.
 *
 * ⚠ ENTITLEMENT WINS BEFORE RECENCY, AND THAT ORDER IS THE POINT. Recency
 * alone answers the ordinary case — resubscribing after churn — but it answers
 * it by accident, because the new subscription happens to have been modified
 * last. It gives the wrong answer the moment anything at all touches an ended
 * subscription after a live one was created, and that is a downgrade for
 * somebody who is paying. Asking "does Polar say this customer holds a plan"
 * first cannot fail that way: if any subscription entitles them, they are
 * entitled, and recency only picks between subscriptions that agree.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN THE RECONCILER BECAUSE IT IS NOW ASKED IN TWO
 * PLACES, AND THE SECOND ONE IS WHERE IT MATTERS MOST. `pick` below is what the
 * post-checkout page uses to decide which of a customer's subscriptions to
 * grant from — and a customer who deleted an account and signed up again has
 * two, one dead and one just paid for. Reading the list in order there would
 * let the dead one decide, which is the precise bug this ordering prevents in
 * the reconciler.
 */
export function supersedes(
  candidate: SubscriptionState,
  held: SubscriptionState,
  freePlanId: string,
): boolean {
  const candidateEntitles = candidate.entitledPlanId !== freePlanId
  const heldEntitles = held.entitledPlanId !== freePlanId
  if (candidateEntitles !== heldEntitles) return candidateEntitles
  return candidate.eventAt.getTime() > held.eventAt.getTime()
}

/**
 * The one subscription that decides a tenant's plan, out of everything Polar
 * holds for a customer.
 *
 * ⚠ POLAR NEVER DELETES A SUBSCRIPTION — a cancelled one stays in the list with
 * status `canceled` for ever — so "the customer's subscriptions" is a growing
 * list of which at most one is live, and `core.subscriptions` holds exactly one
 * row per tenant. Applying them in list order means the dead one gets its turn
 * at writing the live one's row, and the only thing standing between a paying
 * customer and a downgrade is the `event_at` guard in `record` happening to
 * reject it.
 */
export function pick(
  subs: readonly (PolarSubscription | undefined)[],
  opts: DecideOptions,
  tenantId?: string,
): SubscriptionState | null {
  let held: SubscriptionState | null = null

  for (const sub of subs) {
    const decided = toState(sub, opts)
    if (decided.kind === "ignore") continue
    // ⚠ AND ONLY FOR THE TENANT ASKED ABOUT, WHEN ONE IS NAMED. One Polar
    // customer can hold several subscriptions; deciding from a state whose
    // tenant is not the one we are answering for would be writing an
    // entitlement off the back of somebody else's purchase.
    if (tenantId && decided.state.tenantId !== tenantId) continue

    if (!held || supersedes(decided.state, held, opts.freePlanId)) {
      held = decided.state
    }
  }

  return held
}

/**
 * The subscription a succeeded checkout produced, attributed to the tenant that
 * checkout names.
 *
 * ⚠ THIS EXISTS BECAUSE `pick` CANNOT ANSWER FOR THE CUSTOMER WHO HAS BOUGHT
 * BEFORE, AND THAT IS THE COMMON CASE RATHER THAN AN EDGE ONE. It filters by
 * `customer.external_id`, which names whoever created the Polar customer — so
 * for anybody on their second workspace it discards every subscription they
 * own, including the one they have just paid for, and grants nothing at all.
 * Silently: no error, no `stranded`, just a page that spins and a plan that
 * never arrives. That is the bug this function is the fix for.
 *
 * ⚠ AND IT NEEDS NO `customers` SCOPE, WHICH IS THE OTHER HALF OF WHY. Repairing
 * `external_id` requires `customers:read` and `customers:write`, which a Polar
 * organisation access token does NOT carry by default — so on a deployment
 * missing them the repair path cannot even look at the customer, let alone fix
 * it. Checkouts and subscriptions are readable with the scopes every deployment
 * already has.
 *
 * ⚠ THE PRODUCT MUST MATCH THE CHECKOUT'S. One customer can hold subscriptions
 * to several products; the one being granted has to be the one that was bought
 * here, not the largest thing on the account.
 *
 * ⚠ AND NEWEST-CREATED WINS AMONG EQUALS, NOT `supersedes`. That rule ranks by
 * entitlement first and is right for "what does this tenant hold overall" —
 * here the question is narrower and has an exact answer: Polar creates the
 * subscription moments after the checkout succeeds, so the newest one for that
 * product IS the one just bought. Observed: six cancelled subscriptions for the
 * same product on the same customer, any of which `supersedes` would have been
 * content to return once they were all equally unentitling.
 */
export function pickForCheckout(
  subs: readonly (PolarSubscription | undefined)[],
  opts: DecideOptions,
  checkout: { tenantId: string; productId: string | null; createdAt?: string | null },
): SubscriptionState | null {
  let held: SubscriptionState | null = null
  let heldAt = -Infinity

  /*
   * ⚠ THE SUBSCRIPTION THIS CHECKOUT MADE CANNOT PREDATE THE CHECKOUT, and that
   * one inequality is what keeps the override honest. Two live workspaces can
   * share a Polar customer — same person, same email — and without a floor this
   * would happily attribute the OTHER workspace's older subscription to
   * whoever just completed a checkout. Polar creates the subscription moments
   * after the money clears, so anything older than the checkout belongs to a
   * different purchase.
   */
  const floor = Date.parse(checkout.createdAt ?? "") || 0

  for (const sub of subs) {
    if (!sub) continue
    if (checkout.productId && sub.product_id !== checkout.productId) continue

    const createdAt = Date.parse(sub.created_at ?? "") || 0
    if (floor && createdAt && createdAt < floor) continue

    const decided = toState(sub, opts, checkout.tenantId)
    if (decided.kind === "ignore") continue

    // `created_at` rather than `modified_at`: cancelling touches the second and
    // never the first, and "which subscription did this checkout make" is a
    // question about when it came into existence.
    if (!held || createdAt > heldAt) {
      held = decided.state
      heldAt = createdAt
    }
  }

  return held
}
