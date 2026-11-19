"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { Badge } from "@repo/ui/components/badge/badge"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Status } from "@/components/status"
import { CheckoutOutcome } from "@/components/checkout-outcome"
import { PlanCards } from "@/components/plan-cards"
import { PanelError } from "@/components/panel-error"
import { PaymentMethodButton } from "@/components/payment-method-button"
import { ArrivalQuery } from "@/components/arrival-query"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { ARRIVAL } from "@/lib/arrival"
import { billingShape, type BillingData, type BillingShape } from "@/lib/shapes/billing"
import type { BillingState } from "@/lib/types"
import { useExactTime } from "@/components/time"

const NO_BILLING: BillingState = {
  plan: null,
  subscription: null,
  anchor: null,
  overage_enabled: false,
  storage_bytes: null,
}

const NO_SUBSCRIPTION = "No paid subscription. You are on the included allowance."

export function BillingLoading() {
  return <BillingView shape={useRememberedShape(billingShape)} />
}

export function BillingView({
  shape,
  data,
}: {
  shape: BillingShape
  data?: BillingData
}) {
  const exact = useExactTime()
  const loading = data === undefined
  const billing = data?.billing ?? NO_BILLING

  const descriptionLine = () => {
    if (loading) return null
    if (billing.subscription) {
      /*
       * ⚠ A SCHEDULED CHANGE IS CHECKED FIRST, BECAUSE IT IS THE
       * ONE THING THIS LINE COULD NOT SAY. A downgrade is applied
       * at the period boundary so the customer keeps what they paid
       * for - which means every other field here still describes the
       * plan they are leaving, and the page read "Pro - renews on
       * the 4th" to somebody who had just downgraded. That is
       * indistinguishable from the button having done nothing, and
       * it is the same complaint cancelling used to get.
       */
      if (data?.scheduledName) {
        return `Changes to ${data.scheduledName} ${
          billing.subscription.scheduled_at
            ? `on ${exact(billing.subscription.scheduled_at)}`
            : "at the end of this period"
        } - you keep ${billing.plan?.name ?? "your current plan"} until then.`
      }
      if (billing.subscription.cancel_at_period_end) {
        /*
         * ⚠ A CANCELLED SUBSCRIPTION IS STILL ACTIVE UNTIL THE
         * PERIOD ENDS, AND SAYING "cancelled" ALONE WOULD MAKE
         * SOMEBODY THINK THEIR SENDING HAS STOPPED. The date is
         * the whole message.
         */
        return `Ends ${
          billing.subscription.current_period_end
            ? exact(billing.subscription.current_period_end)
            : "at the end of this period"
        } - sending continues until then.`
      }
      if (billing.subscription.current_period_end) {
        return `Renews ${exact(billing.subscription.current_period_end)}`
      }
      return "Active"
    }
    return NO_SUBSCRIPTION
  }

  return (
    <BoneScope id="billing" loading={loading}>
      <div>
        <Section className="pt-0">
          <SectionTitle>Current plan</SectionTitle>
          <SectionContent>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  <Bone id="plan-name" width={110} lineHeight={20} inline>
                    {loading ? undefined : (billing.plan?.name ?? "No plan assigned")}
                  </Bone>
                  {shape.custom && (
                    <Bone
                      id="plan-custom"
                      shape="box"
                      width={56}
                      height={20}
                      radius={4}
                      inline
                      className="ml-2"
                    >
                      <Badge tone="neutral">Custom</Badge>
                    </Bone>
                  )}
                </p>
                {shape.subscription !== "none" ? (
                  <Bone id="plan-desc" width={240} lineHeight={16} className="mt-0.5">
                    {loading ? undefined : (
                      <p className="text-xs text-muted-foreground">
                        {descriptionLine()}
                      </p>
                    )}
                  </Bone>
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {loading ? NO_SUBSCRIPTION : descriptionLine()}
                  </p>
                )}
              </div>

              {shape.subscription !== "none" && (
                <Bone
                  id="plan-status"
                  shape="box"
                  width={64}
                  height={22}
                  radius={9999}
                  inline
                >
                  {billing.subscription && (
                    <Status status={billing.subscription.status} variant="pill" />
                  )}
                </Bone>
              )}
            </div>

            {/*
             * ⚠ THE OUTCOME USED TO BE A SECTION OF ITS OWN AND THAT SECTION WAS
             * THE JUMP. `Section` carries `border-b py-6`, and it is rendered by
             * the server the moment `?checkout_id=` is in the URL - so the page
             * painted an empty bordered box with 24px of padding, and the banner
             * only grew into it a second later when the poll answered. The
             * separator arriving in one frame is what pushed everything down.
             *
             * ⚠ SO IT LIVES UNDER THE PLAN CARD INSTEAD, INSIDE THAT SECTION. It
             * is news about the plan named directly above it, the whole block
             * animates as one, and there is no rule of its own to appear before it
             * has anything to say.
             */}
            {/* ⚠ `pt-3`, NOT `pb-6`: the gap it owns here is the one above it. */}
            <ArrivalQuery names={[ARRIVAL.checkout]} />
            {shape.checkout && (
              // ⚠ SKIPPED BY test/skeleton-parity: the banner answers one checkout, and
              // a skeleton has no checkout id to ask about.
              <div className="contents" data-skeleton="skip">
                <CheckoutOutcome checkoutId={data?.checkoutId ?? null} spacing="pt-3" />
              </div>
            )}
          </SectionContent>
        </Section>

        <Section>
          <SectionTitle>Plans</SectionTitle>
          <SectionDescription>
            Changing plan takes effect when the payment clears - usually a second or
            two. Your allowances move at that moment, not before.
          </SectionDescription>
          <SectionContent>
            {data?.error !== undefined && !data.plans ? (
              <PanelError
                title="Could not load the plan catalogue"
                message={data.error}
                bare
              />
            ) : (
              <PlanCards
                plans={data?.plans ?? NONE}
                billing={billing}
                loading={loading}
                skeletonCount={shape.plans}
                skeletonEntitlements={shape.entitlements}
                skeletonNote={shape.note}
              />
            )}
          </SectionContent>
        </Section>

        <Section>
          <SectionTitle>Payment method and invoices</SectionTitle>
          <SectionDescription>
            Card details and receipts are held by our payment provider - we never see or
            store a card number.
          </SectionDescription>
          <SectionContent className="space-y-3">
            {/*
             * ⚠ THE CARD IS SELF-SERVE; THE INVOICE LIST IS STILL NOT. Polar's
             * embedded payment-method form takes a customer-session token, which
             * `/console/billing/payment-method-session` now mints - so adding or
             * replacing a card is a button. Listing past invoices needs a
             * different surface of Polar's portal and is still written up in
             * docs/decisions/console.md §7, which is why the sentence below stays
             * rather than becoming a second, dead button.
             */}
            <PaymentMethodButton
              hasSubscription={shape.subscription !== "none"}
              loading={loading}
            />

            {shape.subscription === "none" && (
              /*
               * ⚠ THE CARD IS COLLECTED DURING CHECKOUT, AND SAYING SO IS BETTER
               * THAN A BUTTON THAT WOULD FAIL. Polar has no customer record for a
               * workspace that has never subscribed, so minting a portal session
               * for one answers "Customer does not exist" - see
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
      {data && data.error === undefined && (
        <RememberShape def={billingShape} shape={shape} />
      )}
    </BoneScope>
  )
}
