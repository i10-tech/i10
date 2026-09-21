import type { Metadata } from "next"
import { Badge } from "@repo/ui/components/badge"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { CheckoutOutcome } from "@/components/checkout-outcome"
import { PlanCards } from "@/components/plan-cards"
import { PanelError } from "@/components/panel-error"
import { PaymentMethodButton } from "@/components/payment-method-button"
import { tryApi } from "@/lib/api"
import { formatExact } from "@/lib/format"
import { hasLiveSubscription } from "@/lib/billing"
import type { BillingState, FeatureUsage, PlanSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Billing" }

/**
 * The plan, and how to change it.
 *
 * ⚠ NOTHING ON THIS PAGE GRANTS ANYTHING. Starting a checkout returns a URL;
 * changing a plan returns a 202. The entitlement moves only when Polar's
 * signature-verified webhook says the money arrived — see
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
  const { checkout_id: checkoutId } = await searchParams

  const [plans, usage] = await Promise.all([
    tryApi<{ data: PlanSummary[] }>("/console/plans"),
    tryApi<{ usage: FeatureUsage[]; billing: BillingState }>("/console/usage"),
  ])

  if (!usage.ok) {
    return <PanelError title="Could not load billing" message={usage.error.message} />
  }

  const { billing } = usage.data

  /*
   * ⚠ THE NAME, NOT THE ID. `scheduled_plan_id` is our internal handle — `pro`,
   * `starter` — and everything else on this page renders `plan.name`. Printing
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

  return (
    <div>
      {checkoutId && (
        <Section className="pt-0">
          <CheckoutOutcome checkoutId={checkoutId} />
        </Section>
      )}

      <Section className={checkoutId ? undefined : "pt-0"}>
        <SectionTitle>Current plan</SectionTitle>
        <SectionContent>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {billing.plan?.name ?? "No plan assigned"}
                {billing.plan?.source === "custom" && (
                  <Badge variant="outline" className="ml-2">
                    Custom
                  </Badge>
                )}
              </p>
              {billing.subscription ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {/*
                   * ⚠ A SCHEDULED CHANGE IS CHECKED FIRST, BECAUSE IT IS THE
                   * ONE THING THIS LINE COULD NOT SAY. A downgrade is applied
                   * at the period boundary so the customer keeps what they paid
                   * for — which means every other field here still describes the
                   * plan they are leaving, and the page read "Pro — renews on
                   * the 4th" to somebody who had just downgraded. That is
                   * indistinguishable from the button having done nothing, and
                   * it is the same complaint cancelling used to get.
                   */}
                  {scheduledName
                    ? `Changes to ${scheduledName} ${
                        billing.subscription.scheduled_at
                          ? `on ${formatExact(billing.subscription.scheduled_at)}`
                          : "at the end of this period"
                      } — you keep ${billing.plan?.name ?? "your current plan"} until then.`
                    : billing.subscription.cancel_at_period_end
                      ? /*
                         * ⚠ A CANCELLED SUBSCRIPTION IS STILL ACTIVE UNTIL THE
                         * PERIOD ENDS, AND SAYING "cancelled" ALONE WOULD MAKE
                         * SOMEBODY THINK THEIR SENDING HAS STOPPED. The date is
                         * the whole message.
                         */
                        `Ends ${
                          billing.subscription.current_period_end
                            ? formatExact(billing.subscription.current_period_end)
                            : "at the end of this period"
                        } — sending continues until then.`
                      : billing.subscription.current_period_end
                        ? `Renews ${formatExact(billing.subscription.current_period_end)}`
                        : "Active"}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  No paid subscription. You are on the included allowance.
                </p>
              )}
            </div>

            {billing.subscription && (
              <Status status={billing.subscription.status} variant="pill" />
            )}
          </div>
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Plans</SectionTitle>
        <SectionDescription>
          Changing plan takes effect when the payment clears — usually a second or two.
          Your allowances move at that moment, not before.
        </SectionDescription>
        <SectionContent>
          {!plans.ok ? (
            <PanelError
              title="Could not load the plan catalogue"
              message={plans.error.message}
              bare
            />
          ) : (
            <PlanCards
              plans={plans.data.data}
              currentPlanId={billing.plan?.id ?? null}
              hasSubscription={hasLiveSubscription(billing)}
              // ⚠ ONLY WHEN IT IS ACTUALLY ENDING. `cancel_at_period_end` with no
              // date is a subscription Polar has marked but not yet dated; the
              // cards use the presence of a date to decide whether to disable
              // the free plan, so an empty string would disable it with nothing
              // to show.
              endingAt={
                billing.subscription?.cancel_at_period_end &&
                billing.subscription.current_period_end
                  ? formatExact(billing.subscription.current_period_end)
                  : null
              }
              // ⚠ THE SAME RULE `endingAt` FOLLOWS, FOR THE OTHER DEFERRED
              // CHANGE. A card whose plan is already scheduled must not offer
              // "Downgrade" again: pressing it sends a second PATCH that
              // supersedes an identical pending update, which changes nothing
              // and reads as the first press having failed.
              scheduledPlanId={billing.subscription?.scheduled_plan_id ?? null}
              scheduledAt={
                billing.subscription?.scheduled_at
                  ? formatExact(billing.subscription.scheduled_at)
                  : null
              }
            />
          )}
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Payment method and invoices</SectionTitle>
        <SectionDescription>
          Card details and receipts are held by our payment provider — we never see or
          store a card number.
        </SectionDescription>
        <SectionContent className="space-y-3">
          {/*
           * ⚠ THE CARD IS SELF-SERVE; THE INVOICE LIST IS STILL NOT. Polar's
           * embedded payment-method form takes a customer-session token, which
           * `/console/billing/payment-method-session` now mints — so adding or
           * replacing a card is a button. Listing past invoices needs a
           * different surface of Polar's portal and is still written up in
           * docs/decisions/console.md §7, which is why the sentence below stays
           * rather than becoming a second, dead button.
           */}
          <PaymentMethodButton hasSubscription={hasLiveSubscription(billing)} />

          {!billing.subscription && (
            /*
             * ⚠ THE CARD IS COLLECTED DURING CHECKOUT, AND SAYING SO IS BETTER
             * THAN A BUTTON THAT WOULD FAIL. Polar has no customer record for a
             * workspace that has never subscribed, so minting a portal session
             * for one answers "Customer does not exist" — see
             * `PaymentMethodButton`. There is genuinely nothing to manage yet.
             */
            <p className="text-sm text-muted-foreground">
              No card on file. One is collected when you start a plan.
            </p>
          )}

          <p className="text-sm text-muted-foreground">
            To download an invoice, reply to any billing email from us, or contact{" "}
            <a
              href="mailto:support@i10.tech"
              className="text-foreground underline underline-offset-4"
            >
              support@i10.tech
            </a>
            . A full invoice history is next.
          </p>
        </SectionContent>
      </Section>
    </div>
  )
}
