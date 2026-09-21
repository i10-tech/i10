"use client"

import * as React from "react"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Reveal } from "@repo/ui/components/reveal"
import { BillingBanner, CheckoutOutcome } from "@/components/checkout-outcome"
import { PlanCards } from "@/components/plan-cards"
import { onPaidPlan } from "@/lib/billing"
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
  checkoutId,
  onDone,
  onSubscribed,
}: {
  plans: PlanSummary[]
  billing: BillingState
  /**
   * ⚠ THREADED FROM THE PAGE RATHER THAN READ WITH `useSearchParams`, so this
   * stays a component that renders what it is given. The hook would also pull
   * the whole client tree above it out of prerendering unless it were wrapped
   * in its own Suspense boundary — a real cost for a value the server already
   * has in `searchParams`.
   */
  checkoutId: string | null
  onDone: () => void
  /**
   * ⚠ TOLD UPWARDS SO THE SHELL CAN CHANGE ITS FOOTER. Once somebody has
   * paid, "You can come back to this at any time" is advice about a step
   * that is finished — and the shell owns that line, not this step.
   */
  onSubscribed?: () => void
}) {
  /*
   * ⚠ LOCAL, AND SET FROM THE CHECKOUT RATHER THAN FROM `billing`. Nothing
   * re-fetches after a payment any more — see the note on `subscribed` in
   * PlanCards — so this step learns it the same way the cards do: from the
   * success it was just handed.
   */
  const [paid, setPaid] = React.useState(false)

  /*
   * ⚠ THE BANNER'S ID LIVES HERE, NOT IN THE URL, ONCE A CHECKOUT HAS RUN IN
   * THIS TAB. It arrives as a prop from `searchParams` for a reload or a
   * redirect return; handed straight over by the cards, it needs no
   * navigation to reach the banner — and the navigation was the blank frame
   * that killed the toast.
   */
  const [liveCheckout, setLiveCheckout] = React.useState<string | null>(null)
  const outcomeId = liveCheckout ?? checkoutId

  /**
   * What the banner above the cards is currently saying.
   *
   * ⚠ IT HAS TO BE ABLE TO STOP SAYING THINGS, WHICH IS WHY THIS IS A MODE
   * AND NOT A FLAG. "You're on Pro" is true right up until somebody presses
   * Downgrade, and then it is the loudest wrong thing on the screen — it sat
   * there, green and confident, over a subscription that had just been set
   * to end.
   *
   * ⚠ AND `null` IS A STATE THE BANNER IS TOLD ABOUT RATHER THAN REMOVED BY.
   * Both banners keep their place in the tree and animate out; unmounting
   * them would make the news vanish between two frames, which is the jump
   * this whole screen has been chasing out.
   */
  const [news, setNews] = React.useState<"checkout" | "keeping" | null>("checkout")

  /*
   * ⚠ EITHER A PAYMENT IN THIS SESSION OR A SUBSCRIPTION THAT WAS ALREADY
   * THERE. The step is finished in both cases, and reading only the first
   * left somebody who paid last week looking at a step that still wanted
   * something from them.
   */
  const done = paid || onPaidPlan(billing)

  return (
    <div className="space-y-6">
      {/*
       * ⚠ BUYING DURING ONBOARDING NEEDED THE SAME ANSWER AND HAD NOWHERE TO
       * PUT IT. `PlanCards` renders here as well as on the billing page, and
       * both Polar's redirect and our own embedded flow come back with
       * `?checkout_id=` — but only the billing page read it, so somebody who
       * upgraded mid-set-up got a toast and nothing else. Same component, same
       * row, same answer.
       */}
      {outcomeId && (
        <CheckoutOutcome checkoutId={outcomeId} show={news === "checkout"} />
      )}

      {/*
       * ⚠ THE ANSWER TO "Keep subscription", IN THE PLACE THE LAST ANSWER
       * WAS. Pressing it un-marks a subscription that was going to end, and
       * without a word here the only evidence was a card quietly changing
       * back — easy to miss, and the opposite of the cancellation, which
       * announces itself.
       */}
      <BillingBanner
        show={news === "keeping"}
        tone="success"
        icon={<CheckCircle2 className="size-5 text-success" />}
        /*
         * ⚠ "You're", NOT "You are", BECAUSE THE BANNER BESIDE IT SAYS
         * "You're on Pro". These two appear in the same place, minutes
         * apart, and one of them spelling the contraction out reads as a
         * different voice — see `present` in lib/checkout-outcome.ts.
         */
        title={`You're keeping ${billing.plan?.name ?? "your plan"}`}
        body="Nothing was charged and nothing changes — the cancellation is called off and your plan renews as usual."
      />

      {/*
       * ⚠ THE HEADING ASKS FOR A DECISION NOW, RATHER THAN NARRATING ONE
       * ALREADY MADE. This said "You are on Free" over a meter panel and a
       * "Change plan" heading, which framed the last step of set-up as a
       * receipt with an afterthought attached — so the cards read as optional
       * detail and the only live control was "Finish set-up" at the bottom.
       */}
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          {outcomeId ? "You're all set" : "Pick a plan"}
        </h1>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {outcomeId
            ? "Your plan is active. Carry on, or change it here — you can do either at any time."
            : "Start free and change it whenever. Allowances move the moment a payment clears."}
        </p>
      </div>

      {/*
       * ⚠ THE METER PANEL IS GONE, AND WITH IT THE ONLY REASON THIS STEP HAD
       * TO BE TALL. It listed the current plan's allowances as five meters at
       * zero used — the numbers are on the plan cards a few inches below, in
       * the card for that same plan, so the screen said everything twice and
       * gave the duplicate the more prominent half of the page.
       *
       * ⚠ WHAT IT WAS FOR IS NOT LOST. The original note is right that
       * somebody should meet the limits before a 403 does the telling; the
       * cards carry exactly those numbers, and the overview's usage rail is
       * where they belong once there is usage to show.
       */}
      {plans.length > 1 && (
        /*
         * ⚠ WIDER THAN THE FLOW IT SITS IN, DELIBERATELY. Every other step is
         * a form at `max-w-2xl`, which is the right measure for reading and
         * the wrong one for three cards side by side — at that width they
         * stack into a column of tall boxes and the comparison, which is the
         * entire job of this step, has to be done by scrolling. This breaks
         * out to the middle of the viewport and stops at `max-w-4xl`.
         */
        <div className="relative left-1/2 w-[calc(100vw-3rem)] max-w-4xl -translate-x-1/2">
          <PlanCards
            plans={plans}
            billing={billing}
            /*
             * ⚠ THE CURRENT PLAN'S CARD IS HOW THIS STEP ENDS, WHICH IS WHY
             * "Finish set-up" IS NO LONGER UNDER IT. Staying on free was
             * already the commonest way out of set-up and the card for it
             * said "Current plan" and could not be pressed — so the actual
             * exit was an unrelated button below, and the card that described
             * the choice somebody was making was the one dead control on the
             * screen.
             */
            onKeep={onDone}
            onCheckout={(id) => {
              setLiveCheckout(id)
              setNews("checkout")
            }}
            onCancelled={() => setNews(null)}
            onResumed={() => setNews("keeping")}
            onSubscribed={() => {
              setPaid(true)
              onSubscribed?.()
            }}
          />
        </div>
      )}

      {/*
       * ⚠ THE WAY OUT ONLY EXISTS ONCE THERE IS SOMETHING TO LEAVE. Until a
       * payment lands, staying on the current plan IS the exit and its card
       * carries it; afterwards that card reads "Subscribed" and is inert, so
       * without this the last step of set-up would have no forward control at
       * all.
       *
       * ⚠ REVEALED, ON THE SAME SPRING AS EVERYTHING ELSE. It arrives a
       * second after a checkout closes, which is exactly the moment a hard
       * insert reads as the page glitching — the fault this whole change set
       * out to remove.
       */}
      <Reveal show={done} spacing="pt-2">
        <div className="flex justify-center">
          {/*
           * ⚠ `xl`, THE SAME SIZE AS "Continue" ON THE SIGN-IN PAGE. It is
           * the same kind of control — the one thing to press on a screen
           * that has finished asking — and for a new customer the two are
           * three minutes apart.
           */}
          <Button size="xl" onClick={onDone}>
            Continue to dashboard
            <ArrowRight />
          </Button>
        </div>
      </Reveal>
    </div>
  )
}
