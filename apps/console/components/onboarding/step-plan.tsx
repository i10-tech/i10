"use client"

import { MeterRow } from "@repo/ui/components/meter"
import { Button } from "@repo/ui/components/button"
import { PlanCards } from "@/components/plan-cards"
import { formatBytes, formatNumber } from "@/lib/format"
import type { BillingState, PlanSummary } from "@/lib/types"

/**
 * What the plan includes, before anyone hits a limit.
 *
 * ⚠ SHOWING METERING AT THE END OF SET-UP IS THE POINT OF THIS STEP. The
 * alternative is that the first time somebody learns there is a limit is a 403
 * in production at 2am. Putting the numbers in front of them while they are
 * still paying attention costs one screen and removes an entire category of
 * support ticket.
 *
 * ⚠ AND THE UPGRADE BUTTON IS HERE RATHER THAN ONLY ON A BILLING PAGE, because
 * this is the moment somebody knows what they are about to send and can judge
 * whether the free allowance covers it. Asking later means asking after they
 * have been refused.
 */
export function StepPlan({
  plans,
  billing,
  onDone,
}: {
  plans: PlanSummary[]
  billing: BillingState
  onDone: () => void
}) {
  const current = billing.plan

  // ⚠ DERIVED FROM THE CATALOGUE, NOT FROM A METER READ. This step runs before
  // anybody has sent anything, so a usage query would show five zeroes; what is
  // useful here is what the plan GRANTS.
  const entitlements = current?.entitlements ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {current ? `You are on ${current.name}` : "Your plan"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Here is what that includes. You can change plan at any time — allowances
          move the moment the payment clears.
        </p>
      </div>

      {entitlements.length > 0 && (
        <div className="max-w-xl space-y-5 rounded-lg border p-4">
          {entitlements.map((entitlement) => (
            <MeterRow
              key={entitlement.featureId}
              label={
                LABELS[entitlement.featureId] ?? entitlement.featureId
              }
              used={0}
              limit={entitlement.allowance}
              format={
                entitlement.featureId === "storage.bytes"
                  ? (n) => formatBytes(n)
                  : (n) => formatNumber(n)
              }
              unit={entitlement.interval ? `per ${entitlement.interval}` : undefined}
            />
          ))}
        </div>
      )}

      {plans.length > 1 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Change plan</h2>
          <PlanCards
            plans={plans}
            currentPlanId={current?.id ?? null}
            hasSubscription={billing.subscription !== null}
          />
        </div>
      )}

      <Button onClick={onDone}>Finish set-up</Button>
    </div>
  )
}

const LABELS: Record<string, string> = {
  emails: "Emails",
  "domains.sending": "Sending domains",
  "domains.mailbox": "Mailbox domains",
  mailboxes: "Mailboxes",
  "storage.bytes": "Mailbox storage",
}
