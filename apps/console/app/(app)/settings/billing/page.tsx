import type { Metadata } from "next"
import { BillingView } from "@/components/billing-view"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { billingShape, type BillingData } from "@/lib/shapes/billing"
import type { BillingState, FeatureUsage, PlanSummary } from "@/lib/types"
import { ARRIVAL } from "@/lib/arrival"
import { readArrival } from "@/lib/arrival-server"

export const metadata: Metadata = { title: "Billing" }

/**
 * The plan, and how to change it.
 *
 * ⚠ NOTHING ON THIS PAGE GRANTS ANYTHING. Starting a checkout returns a URL;
 * changing a plan returns a 202. The entitlement moves only when Polar's
 * signature-verified webhook says the money arrived - see
 * apps/api/src/routes/polar-events.ts. That is why the buttons say what they do
 * rather than claiming the plan has changed.
 *
 * ⚠ AND CHECKOUT AND PLAN-CHANGE ARE DIFFERENT CALLS, CHOSEN BY WHETHER A
 * SUBSCRIPTION ALREADY EXISTS. Sending an existing customer through checkout
 * again creates a SECOND subscription and bills them twice; sending a new one
 * through a plan change has nothing to change. The rule lives in `PlanCards`,
 * which reads `billing.subscription`.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout_id?: string }>
}) {
  // ⚠ POLAR APPENDS THIS ON THE WAY BACK. `success_url` now points at whichever
  // page started the checkout rather than at one confirmation screen for the
  // whole product, so the outcome is reported here, in place, above the plan
  // the customer just bought. See routes/console/account.ts.
  // ⚠ READ ONCE FROM THE QUERY, THEN FROM A COOKIE - `ArrivalQuery` below
  // moves it out of the address bar on arrival. See lib/arrival.ts.
  const checkoutId = await readArrival(
    ARRIVAL.checkout,
    (await searchParams).checkout_id,
  )

  const [plans, usage] = await Promise.all([
    tryApi<{ data: PlanSummary[] }>("/console/plans"),
    tryApi<{ usage: FeatureUsage[]; billing: BillingState }>("/console/usage"),
  ])

  if (!usage.ok) {
    return <PanelError title="Could not load billing" message={usage.error.message} />
  }

  const { billing } = usage.data

  /*
   * ⚠ THE NAME, NOT THE ID. `scheduled_plan_id` is our internal handle - `pro`,
   * `starter` - and everything else on this page renders `plan.name`. Printing
   * the id would be the only place in the console where a customer is shown one,
   * in the sentence that is supposed to reassure them about a change they just
   * made. The catalogue may fail to load, in which case the id is still better
   * than saying nothing.
   */
  const scheduledName = billing.subscription?.scheduled_plan_id
    ? ((plans.ok
        ? plans.data.data.find((p) => p.id === billing.subscription?.scheduled_plan_id)
            ?.name
        : null) ?? billing.subscription.scheduled_plan_id)
    : null

  const data: BillingData = {
    billing,
    plans: plans.ok ? plans.data.data : [],
    checkoutId,
    scheduledName,
    ...(plans.ok ? {} : { error: plans.error.message }),
  }

  return <BillingView shape={billingShape.of(data)} data={data} />
}
