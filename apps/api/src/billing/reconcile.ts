import {
  toState,
  type DecideOptions,
  type PolarSubscription,
  type SubscriptionState,
} from "./events.js"
import type { SubscriptionOps } from "./db.js"
import type { Logger, SubscriptionGrants } from "./grants.js"
import type { PolarClient } from "./polar.js"

/**
 * Bringing our entitlements back into agreement with Polar.
 *
 * ⚠ THIS IS NOT OPTIONAL, AND IT IS NOT A SAFETY NET FOR SLOPPINESS. Attaching
 * plans with `no_billing_changes: true` makes Polar the state of record and
 * our own tables a downstream copy — and the only thing that carries state from the one
 * to the other is a webhook. A webhook lost during a deploy, dropped by a
 * rollout, or 500'd past its retry budget is a customer silently on the wrong
 * plan, in either direction: paying for Pro with free-tier limits, or holding
 * Pro they stopped paying for. Nothing downstream will ever notice, because it
 * was told the truth as far as it knew.
 *
 * ⚠ IT READS POLAR, NOT OUR OWN TABLES. The question is "does our record match
 * the payment provider", and our record cannot answer it — it holds whatever we
 * last
 * told it, so comparing the two would only ever confirm our own mistake.
 *
 * ⚠ AND IT NEVER REVOKES ON ABSENCE. See `orphaned` below: a subscription
 * missing from Polar's list is a data problem, not a churned customer, and
 * treating absence as cancellation turns one bad access token into every
 * customer being downgraded at once.
 */

export interface ReconcileDeps {
  polar: PolarClient
  subscriptions: SubscriptionOps
  grants: SubscriptionGrants
  options: DecideOptions
  log: Logger
}

export interface ReconcileReport {
  /**
   * Tenants Polar returned at least one i10 subscription for.
   *
   * ⚠ TENANTS, NOT SUBSCRIPTIONS, BECAUSE POLAR NEVER DELETES ONE. A customer
   * who has bought twice has two subscriptions in the list forever, and we
   * hold one row per tenant — so `agreed + repaired + failed` counts decisions
   * made, and this is the number of them.
   */
  checked: number
  /** Entitlements this run repaired. Should be zero on a healthy deployment. */
  repaired: number
  /** Already in agreement. */
  agreed: number
  /**
   * Rows of ours that Polar has no subscription for.
   *
   * ⚠ REPORTED, NEVER ACTED ON. Polar does not delete subscriptions — a
   * cancelled one stays in the list with status `canceled` — so a row missing
   * from it means our data is wrong, or the access token points at a different
   * organisation or the other environment. Downgrading here would mean one
   * mis-scoped token silently strips every paying customer of the plan they
   * bought, and the automation would look like it was working.
   */
  orphaned: string[]
  /** Tenants this run could not repair. Each is a reason the job exits non-zero. */
  failed: { tenantId: string; error: string }[]
  /**
   * Polar subscriptions this run could not attribute to any tenant.
   *
   * ⚠ THIS USED TO BE A BARE `continue`, WHICH MADE THE BACKSTOP SILENT ABOUT
   * THE ONE THING IT CANNOT BACK UP. The reconciler exists because a webhook
   * can be lost — but it attributes subscriptions by `customer.external_id`
   * exactly as the webhook does, so a subscription without one is invisible to
   * both, and skipping it quietly meant a run could report perfect agreement
   * while a paying customer sat on the free plan. It is not `orphaned`: that is
   * a row of OURS with no Polar subscription, and this is the mirror image.
   */
  stranded: { subscriptionId: string; reason: string }[]
}

export async function reconcileSubscriptions(
  deps: ReconcileDeps,
): Promise<ReconcileReport> {
  const [polarSubs, ours] = await Promise.all([
    deps.polar.listSubscriptions(),
    deps.subscriptions.snapshot(),
  ])

  const report: ReconcileReport = {
    checked: 0,
    repaired: 0,
    agreed: 0,
    orphaned: [],
    failed: [],
    stranded: [],
  }

  const byTenant = new Map(ours.map((row) => [row.tenantId, row]))
  const seen = new Set<string>()

  // ⚠ ONE SUBSCRIPTION PER TENANT DECIDES, AND CHOOSING WHICH IS NOT
  // BOOKKEEPING. Polar never deletes a subscription — a cancelled one stays in
  // the list with status `canceled` forever — so a customer who has bought
  // twice appears twice, while `core.subscriptions` holds exactly one row for
  // them. Feeding both to `grants.apply` in list order means the dead one gets
  // its turn at writing the live one's row, and the only thing standing
  // between a paying customer and a downgrade is `record`'s `event_at` guard
  // rejecting it. That guard holds today, and it holds for a reason it does
  // not control: that Polar happens not to touch `modified_at` on a
  // subscription it has already ended. One such touch, for any reason, and the
  // dead subscription wins.
  //
  // Observed as noise before it was ever a bug — every run logged an "ignored
  // an out-of-order subscription event" for the old subscription and counted
  // it as agreement.
  const decidedByTenant = new Map<string, SubscriptionState>()

  for (const sub of polarSubs) {
    const decided = toState(sub as PolarSubscription, deps.options)
    if (decided.kind === "ignore") {
      if (decided.stranded) {
        report.stranded.push({
          subscriptionId: (sub as PolarSubscription).id,
          reason: decided.reason,
        })
      }
      continue
    }

    const state = decided.state
    seen.add(state.polarSubscriptionId)

    const held = decidedByTenant.get(state.tenantId)
    if (!held || supersedes(state, held, deps.options.freePlanId)) {
      decidedByTenant.set(state.tenantId, state)
    }
  }

  for (const state of decidedByTenant.values()) {
    report.checked += 1

    const row = byTenant.get(state.tenantId)

    // ⚠ THREE WAYS TO BE OUT OF STEP, AND THE THIRD IS THE ONE THAT MATTERS.
    // No row at all is a webhook we never received. An older `event_at` is one
    // we received out of order or lost. A `granted_plan_id` that disagrees with
    // what the subscription entitles is the row having been written while the
    // grant failed — the state this whole design is built to survive, and
    // the one no other check would ever surface.
    const outOfStep =
      !row ||
      row.eventAt.getTime() < state.eventAt.getTime() ||
      row.grantedPlanId !== state.entitledPlanId

    if (!outOfStep) {
      report.agreed += 1
      continue
    }

    try {
      const outcome = await deps.grants.apply(state)
      if (outcome.status === "applied") {
        report.repaired += 1
        deps.log.warn(
          {
            tenantId: state.tenantId,
            plan: state.entitledPlanId,
            subscriptionId: state.polarSubscriptionId,
            had: row?.grantedPlanId ?? null,
          },
          "reconciler repaired an entitlement the webhook path did not apply",
        )
      } else {
        report.agreed += 1
      }
    } catch (error) {
      // ⚠ ONE TENANT'S FAILURE DOES NOT END THE RUN. The next tenant's plan is
      // unrelated, and aborting would mean a single unreachable customer record
      // holds up every other repair until somebody notices.
      const message = error instanceof Error ? error.message : String(error)
      report.failed.push({ tenantId: state.tenantId, error: message })
      deps.log.error(
        { err: error, tenantId: state.tenantId },
        "could not repair an entitlement",
      )
    }
  }

  for (const row of ours) {
    if (!seen.has(row.polarSubscriptionId)) report.orphaned.push(row.tenantId)
  }

  if (report.orphaned.length > 0) {
    deps.log.error(
      { tenants: report.orphaned, polarSubscriptions: polarSubs.length },
      "subscription rows with no matching Polar subscription — NOT downgraded",
    )
  }

  if (report.stranded.length > 0) {
    deps.log.error(
      { subscriptions: report.stranded },
      "Polar subscriptions that cannot be attributed to a tenant — nothing " +
        "will ever grant these; set each customer's external_id",
    )
  }

  return report
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
 */
function supersedes(
  candidate: SubscriptionState,
  held: SubscriptionState,
  freePlanId: string,
): boolean {
  const candidateEntitles = candidate.entitledPlanId !== freePlanId
  const heldEntitles = held.entitledPlanId !== freePlanId
  if (candidateEntitles !== heldEntitles) return candidateEntitles
  return candidate.eventAt.getTime() > held.eventAt.getTime()
}
