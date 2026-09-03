import { toState, type DecideOptions, type PolarSubscription } from "./events.js"
import type { SubscriptionOps } from "./db.js"
import type { Logger, SubscriptionGrants } from "./grants.js"
import type { PolarClient } from "./polar.js"

/**
 * Bringing our entitlements back into agreement with Polar.
 *
 * ⚠ THIS IS NOT OPTIONAL, AND IT IS NOT A SAFETY NET FOR SLOPPINESS. Attaching
 * plans with `no_billing_changes: true` makes Polar the state of record and
 * Autumn a downstream copy — and the only thing that carries state from the one
 * to the other is a webhook. A webhook lost during a deploy, dropped by a
 * rollout, or 500'd past its retry budget is a customer silently on the wrong
 * plan, in either direction: paying for Pro with free-tier limits, or holding
 * Pro they stopped paying for. Nothing in Autumn will ever notice, because
 * Autumn was told the truth as far as it knows.
 *
 * ⚠ IT READS POLAR, NOT AUTUMN. The question is "does our record match the
 * payment provider", and Autumn cannot answer it — it holds whatever we last
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
  /** Subscriptions Polar returned that map to an i10 plan. */
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
  }

  const byTenant = new Map(ours.map((row) => [row.tenantId, row]))
  const seen = new Set<string>()

  for (const sub of polarSubs) {
    const decided = toState(sub as PolarSubscription, deps.options)
    if (decided.kind === "ignore") continue

    const state = decided.state
    report.checked += 1
    seen.add(state.polarSubscriptionId)

    const row = byTenant.get(state.tenantId)

    // ⚠ THREE WAYS TO BE OUT OF STEP, AND THE THIRD IS THE ONE THAT MATTERS.
    // No row at all is a webhook we never received. An older `event_at` is one
    // we received out of order or lost. A `granted_plan_id` that disagrees with
    // what the subscription entitles is the row having been written while the
    // Autumn call failed — the state this whole design is built to survive, and
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

  return report
}
