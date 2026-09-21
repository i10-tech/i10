"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Check } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { changePlan, resumeSubscription, startCheckout } from "@/lib/actions"
import { openPolarCheckout } from "@/lib/polar-embed"
import { hasLiveSubscription, onPaidPlan } from "@/lib/billing"
import { formatBytes, formatExact, formatNumber } from "@/lib/format"
import type { BillingState, PlanSummary } from "@/lib/types"

/**
 * The plan picker.
 *
 * ⚠ THE ENTITLEMENTS ARE RENDERED FROM THE CATALOGUE, NOT HARD-CODED. The
 * allowances live in `core.plans` as jsonb and are changed by migration or by a
 * config push; a marketing list typed into this component would be a second
 * price list, and the one that is wrong is always the one somebody just bought
 * from. It also means a bespoke plan built for one customer renders correctly
 * here with no code change.
 *
 * ⚠ AND THE BUTTON PICKS BETWEEN TWO DIFFERENT CALLS. A tenant with no
 * subscription goes through checkout; one that already has a subscription goes
 * through a plan change. Sending an existing customer through checkout again
 * creates a SECOND subscription and bills them twice — which is the kind of bug
 * that is discovered by the customer.
 *
 * ⚠ PRICES ARE DELIBERATELY ABSENT. They live in Polar, which owns currency,
 * tax and any discount on the account; rendering a number typed here would be a
 * price we are not actually going to charge, shown next to a button that takes
 * money. The checkout page shows the real one.
 */

const FEATURE_LABELS: Record<string, string> = {
  emails: "emails",
  "domains.sending": "sending domains",
  "domains.mailbox": "mailbox domains",
  mailboxes: "mailboxes",
  "storage.bytes": "mailbox storage",
}

function describeEntitlement(entitlement: PlanSummary["entitlements"][number]): string {
  const label = FEATURE_LABELS[entitlement.featureId] ?? entitlement.featureId

  const amount =
    entitlement.featureId === "storage.bytes"
      ? formatBytes(entitlement.allowance)
      : formatNumber(entitlement.allowance)

  // ⚠ AN INTERVAL MEANS A CONSUMABLE ALLOWANCE THAT RESETS; ITS ABSENCE MEANS A
  // CONTINUOUS LEVEL THAT DOES NOT. "3 sending domains per month" would be
  // nonsense, and "100 emails" without "a day" understates the free plan by a
  // factor of thirty.
  const period = entitlement.interval ? ` / ${entitlement.interval}` : ""

  if (entitlement.allowance === 0) return `No ${label}`
  return `${amount} ${label}${period}`
}

/** `pending` while a cancellation is being called off. Not a plan id. */
const RESUMING = "\u0000resuming"

export function PlanCards({
  plans,
  billing,
  onKeep,
  onSubscribed,
  onCheckout,
}: {
  plans: PlanSummary[]
  /**
   * The whole billing state, rather than five facts derived from it.
   *
   * ⚠ THE DERIVATION USED TO LIVE AT EACH CALL SITE AND THEY DRIFTED, WHICH
   * IS A BUG A CUSTOMER SAW. The billing page worked out `endingAt` and
   * `scheduledPlanId` from `billing.subscription`; the onboarding step passed
   * neither. So somebody who cancelled on the billing page — where the free
   * card correctly went to a disabled "Ending" — walked into set-up and found
   * "Cancel subscription" live again, pressed it, and got a second
   * cancellation refused by Polar and reported as our misconfiguration.
   *
   * ⚠ SO THE COMPONENT DERIVES ITS OWN, AND THERE IS ONE OF IT. Every prop
   * these cards need is a function of the billing state and the catalogue;
   * asking a caller to compute them was asking two callers to agree, forever,
   * about a subscription's deferred states.
   */
  billing: BillingState
  /**
   * What pressing the CURRENT plan's card does, where staying on it is a real
   * choice rather than a statement of fact.
   *
   * ⚠ IT EXISTS FOR THE LAST STEP OF ONBOARDING AND NOWHERE ELSE. On the
   * billing page the current plan is a fact, so its card is a disabled
   * "Current plan" and the only actions are the other two. At the end of
   * set-up the same card is the answer to a question — "this one, thanks" —
   * and leaving it inert meant the only way out of the flow was a separate
   * "Finish set-up" button underneath, which is a second control for a
   * decision the cards were already presenting.
   *
   * ⚠ AND IT IS NOT "CHOOSE THE FREE PLAN". It fires for whichever plan is
   * current, including one just paid for during set-up, because the thing it
   * means is "keep this and move on" — nothing is bought and nothing changes.
   */
  onKeep?: () => void
  /**
   * Told when a checkout on these cards succeeded.
   *
   * ⚠ IT EXISTS SO THE SCREEN AROUND THE CARDS CAN REACT WITHOUT A REFRESH
   * EITHER. The last step of onboarding swaps its footer for a way out once
   * somebody has paid, and the alternative — re-fetching the tree to learn a
   * fact we were just handed — is the blip this whole change removes.
   */
  onSubscribed?: (planId: string) => void
  /**
   * The checkout that just ended, whatever its outcome.
   *
   * ⚠ HANDED OVER RATHER THAN PUT IN THE URL FOR THE SERVER TO PASS BACK.
   * The banner needs the id to poll; routing it through a navigation is what
   * made the page blink. The caller renders the banner from this and the
   * address bar is updated behind it, for a reload.
   */
  onCheckout?: (checkoutId: string) => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { resolvedTheme } = useTheme()
  /*
   * ⚠ A SENTINEL RATHER THAN A SECOND FLAG. `pending` holds the plan id being
   * acted on; resuming is not about a plan, so it needs a value that cannot
   * collide with one — and sharing the flag is what keeps every other card
   * disabled while it runs.
   */
  const [pending, setPending] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<PlanSummary | null>(null)
  /*
   * ⚠ THE PLAN JUST BOUGHT, HELD HERE RATHER THAN RE-READ FROM THE SERVER.
   * This used to be a `router.refresh()`: the checkout closed, a toast said
   * "Payment received", and the whole tree re-rendered underneath it — a
   * black blip, a layout that moved, and the toast gone before it could be
   * read. Everything that actually changes on this screen is knowable from
   * the success we were just handed, so it is applied here instead.
   *
   * ⚠ AND IT IS NOT A LIE ABOUT THE GRANT. Polar has taken the payment; the
   * entitlement lands when their webhook does, a second or two later, which
   * is exactly what the banner above these cards is polling for and saying.
   * This changes what the CARDS say about a purchase that has happened, not
   * what the workspace is entitled to.
   */
  const [subscribed, setSubscribed] = React.useState<string | null>(null)

  /*
   * ⚠ THE PLAN JUST BOUGHT OUTRANKS THE ONE THE SERVER LAST SENT, for as long
   * as this component is mounted. `billing` was rendered before the checkout
   * and cannot know about it; without this the card somebody just paid for
   * would keep offering "Upgrade" until something re-fetched.
   */
  const currentPlanId = subscribed ?? billing.plan?.id ?? null
  const hasSubscription = hasLiveSubscription(billing)

  /*
   * ⚠ ONLY WHEN IT IS ACTUALLY ENDING. `cancel_at_period_end` with no date is
   * a subscription Polar has marked but not yet dated; the cards use the
   * presence of a date to decide whether to disable the free plan, so an
   * empty string would disable it with nothing to show.
   */
  const endingAt =
    billing.subscription?.cancel_at_period_end &&
    billing.subscription.current_period_end
      ? formatExact(billing.subscription.current_period_end)
      : null

  /*
   * ⚠ THE SAME RULE, FOR THE OTHER DEFERRED CHANGE. A card whose plan is
   * already scheduled must not offer "Downgrade" again: pressing it sends a
   * second PATCH that supersedes an identical pending update, which changes
   * nothing and reads as the first press having failed.
   */
  const scheduledPlanId = billing.subscription?.scheduled_plan_id ?? null
  const scheduledAt = billing.subscription?.scheduled_at
    ? formatExact(billing.subscription.scheduled_at)
    : null

  const current = plans.find((plan) => plan.id === currentPlanId) ?? null

  /**
   * Put the checkout on the page's own URL, so its outcome is reported there.
   *
   * ⚠ THIS IS THE WHOLE OF "THE REDIRECT DOES NOT WORK". Polar's redirect back
   * to `success_url?checkout_id=…` is what makes `CheckoutOutcome` render, and
   * in the embedded flow that redirect very often never happens: whichever of
   * their `success` event or our own status poll fires first tears the iframe
   * out, and their default handler — the thing that navigates the parent — does
   * not get to run. The customer was left with a toast that fades after a few
   * seconds and a page that otherwise looked exactly as it had before they
   * paid.
   *
   * ⚠ AND IT IS ATTACHED ON EVERY ENDING, NOT ONLY ON SUCCESS. Failure and
   * abandonment had no feedback at all, which is the same bug in the direction
   * nobody thinks to test. The banner reads the real state from our API — paid,
   * granted, failed, expired, closed — so it tells the truth for all of them
   * rather than being told what to say from here.
   *
   * ⚠ `replace`, NOT `push`. Back should return to wherever they were before
   * the plan page, not to the same page minus a query parameter.
   */
  const reportOutcome = React.useCallback(
    (checkoutId: string | null) => {
      // ⚠ NO ID MEANS NO BANNER, AND THE REFRESH STILL HAPPENS. An older API
      // build returns no checkout id — see `startCheckout` — and there is
      // nothing for the status endpoint to be asked about, so this degrades to
      // exactly the behaviour that existed before rather than routing somebody
      // to `?checkout_id=null`.
      if (!checkoutId) {
        // ⚠ NO BANNER AND NOTHING TO SHOW, SO THIS IS THE ONE PATH THAT STILL
        // RE-READS. Without a checkout id there is no status to poll and no
        // local fact to apply, so the server is the only thing that can say
        // what happened.
        router.refresh()
        return
      }

      // ⚠ `usePathname` IS NULLABLE AND THIS ONLY EVER RUNS IN THE BROWSER, so
      // the real location is both available and authoritative. Defaulting to
      // "" instead would send somebody who just paid to the site root.
      const here = pathname ?? window.location.pathname

      /*
       * ⚠ THE QUERY THAT WAS ALREADY THERE IS KEPT, AND DROPPING IT PUT PEOPLE
       * BACK ON THE WRONG STEP. This used to build the URL from the path alone,
       * so `?step=plan` — which is how onboarding remembers where somebody is —
       * was discarded by the very navigation that reports a successful payment.
       * The flow then remounted, re-derived its step from the facts, and put
       * somebody who had just paid on the last step back on "Verify".
       */
      const params = new URLSearchParams(window.location.search)
      params.set("checkout_id", checkoutId)

      /*
       * ⚠ `history.replaceState`, NOT `router.replace`, AND THIS IS THE LAST
       * OF THE BLIPS. Both put the id in the address bar; only this one does
       * it WITHOUT a navigation. `router.replace` re-fetches the RSC payload
       * for the new URL and re-renders the server tree — which is a blank
       * frame a second after the checkout closes, the toast about the payment
       * killed with it, and the banner and the green tick animating in from
       * nothing as the tree remounts. Exactly what a refresh looked like,
       * because it is one in everything but name.
       *
       * ⚠ THE SAME TECHNIQUE THE ONBOARDING STEPPER ALREADY USES, and for the
       * same reason — see `go` in onboarding.tsx. Next supports it explicitly
       * and keeps `useSearchParams` in sync with it.
       *
       * ⚠ THE URL IS STILL WRITTEN, THOUGH NOTHING READS IT NOW. A reload
       * lands on a page that can recover the banner from the id, which is the
       * only reason it was ever in the address bar; the live banner is handed
       * the id directly through `onCheckout`.
       */
      const url = `${here}?${params.toString()}`

      if (!onCheckout) {
        /*
         * ⚠ THE CALLER CANNOT HOLD THE ID, SO THE URL HAS TO — and that costs
         * a navigation. The billing settings page renders the banner at the
         * top and these cards half a page below it, inside a server
         * component, so there is nowhere between them to keep client state.
         * It keeps the behaviour it has always had; onboarding, where the two
         * are siblings under one client component, takes the quiet path
         * above.
         */
        router.replace(url)
        return
      }

      window.history.replaceState(null, "", url)
      onCheckout(checkoutId)
    },
    [pathname, router, onCheckout],
  )

  /*
   * ⚠ ESCAPE BACKS OUT OF THE ARMED CANCELLATION, and without it there was no
   * way out at all. Pressing "Cancel subscription" turns that card into
   * "Confirm cancellation" and leaves it there: the only exits were pressing
   * a different card or reloading, so somebody who pressed it to see what it
   * said was stuck looking at a primed destructive button. Escape is what
   * every dialog in the product already answers to, and this is a dialog in
   * everything but markup.
   *
   * ⚠ BOUND ONLY WHILE SOMETHING IS ARMED. A permanent listener would swallow
   * nothing and cost nothing, but it would also fire inside the checkout
   * modal and the confirm dialogs that render over these cards — and an
   * Escape meant for one of those is not meant for this.
   */
  React.useEffect(() => {
    if (confirming === null) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [confirming])

  /*
   * ⚠ LEAVING A PAID PLAN IS A CONFIRMED ACTION, NOT A ONE-CLICK DOWNGRADE.
   * Every other button here moves between things somebody is paying for;
   * `free` ends the subscription, and it sits in the same row of identical
   * cards as the rest. The confirmation exists because the consequence is
   * different in kind, not because it is severe — it is reversible by
   * subscribing again, and the dialog says when it takes effect.
   */
  const leavingPaidPlan = (plan: PlanSummary) =>
    hasSubscription && current !== null && plan.rank === 0 && plan.rank < current.rank

  /*
   * ⚠ THE WAY BACK FROM A CANCELLATION, WHICH DID NOT EXIST. Cancelling is
   * deferred to the period boundary — they have paid for the rest of the
   * month — so for up to a month the subscription is alive, billed for, and
   * marked to end, and every control on this screen read that as settled.
   * The only route back was to wait for it to lapse and buy it again.
   *
   * ⚠ IT IS NOT A PURCHASE AND MUST NOT LOOK LIKE ONE. Nothing is charged;
   * the mark is removed from a subscription that is already running, which is
   * why this is a plain button and not a checkout.
   */
  async function resume() {
    if (pending) return
    setPending(RESUMING)

    const result = await resumeSubscription()
    setPending(null)

    if (!result.ok) {
      toast.error("Could not keep your subscription", { description: result.error })
      return
    }

    toast.success("Your subscription will continue")
    router.refresh()
  }

  async function choose(plan: PlanSummary) {
    if (pending) return

    if (leavingPaidPlan(plan) && confirming?.id !== plan.id) {
      setConfirming(plan)
      return
    }

    setConfirming(null)
    setPending(plan.id)

    if (hasSubscription) {
      const result = await changePlan(plan.id)
      setPending(null)

      if (!result.ok) {
        toast.error("Could not change your plan", { description: result.error })
        return
      }

      if (result.data.status === "unchanged") {
        toast("You are already on that plan")
        return
      }

      /*
       * ⚠ 202 MEANS ACCEPTED, NOT DONE. Polar has taken the change; the
       * entitlement moves when their webhook lands, a second or two later. The
       * refresh picks it up — and the message is worded so that somebody who
       * reloads immediately and sees the old plan is not confused.
       *
       * ⚠ AND CANCELLING GETS ITS OWN SENTENCE, because "your allowances move
       * as soon as the payment clears" is wrong for it in both halves: there is
       * no payment, and nothing moves until the period ends.
       */
      if (leavingPaidPlan(plan)) {
        toast.success("Subscription ending", {
          description:
            "You keep your current plan until the end of the period you have " +
            "paid for, then move to the free allowance.",
        })
      } else {
        toast.success("Plan change requested", {
          description: "Your allowances move as soon as the payment clears.",
        })
      }
      router.refresh()
      return
    }

    /*
     * ⚠ THE PAGE THIS WAS PRESSED ON, SO POLAR RETURNS TO IT. The cards render
     * on the billing settings page and inside onboarding, and those are two
     * different places to come back to — one confirmation page for both was a
     * dead end for whichever flow had steps left.
     */
    /*
     * ⚠ PATH *AND* QUERY, FOR THE SAME REASON THE BANNER'S URL KEEPS ITS QUERY.
     * This is the `success_url` Polar sends the browser to when the embed is
     * not used or does not survive, and a path alone loses the step somebody
     * was on — turning the redirect fallback into the same backwards jump the
     * embedded path had.
     */
    const result = await startCheckout(
      plan.id,
      `${window.location.pathname}${window.location.search}`,
    )

    if (!result.ok) {
      setPending(null)
      toast.error("Could not start checkout", { description: result.error })
      return
    }

    /*
     * ⚠ AN OVERLAY ON OUR OWN PAGE RATHER THAN A TRIP TO POLAR'S. Sending
     * somebody to another domain to pay is the highest-drop-off moment in the
     * product: the URL bar changes, the branding changes, and coming back
     * depends on a redirect surviving. Polar's embed renders their checkout in
     * an iframe over this page, so the card fields are still theirs — we never
     * see a card number, and stay in PCI SAQ A — while the page around it stays
     * ours. Verified against the Polar sandbox: a real checkout renders inside
     * an iframe on `localhost:3000`.
     *
     * ⚠ THE REDIRECT IS THE FALLBACK AND IT IS NOT DECORATIVE. The embed script
     * is loaded on demand from the bundle; a chunk that fails to load, a
     * `window.open` blocked by an extension, or any throw inside `create` all
     * land here rather than leaving somebody looking at a button that did
     * nothing. A full navigation is the flow every Polar integration used
     * before embedding existed, so the fallback is a worse experience rather
     * than a broken one.
     */
    try {
      /*
       * ⚠ THE OPEN GOES THROUGH `openPolarCheckout` RATHER THAN THE SDK
       * DIRECTLY, SO THE WAY OUT EXISTS BEFORE THE IFRAME DOES. The SDK's
       * `create()` resolves only when Polar's page posts `loaded`, and every
       * message that page sends is gated on the `embed_origin` we failed to
       * set — so it resolved never, and a full-viewport payment form had
       * nothing behind it. The API sends the field now; that module stops the
       * whole class by binding Escape, drawing a close button and starting the
       * status poll without waiting to be told the frame is ready. See
       * lib/polar-embed.ts.
       */
      await openPolarCheckout(result.data.url, {
        theme: resolvedTheme === "light" ? "light" : "dark",
        // ⚠ WHAT LETS THE MODAL CLOSE WHEN POLAR'S EVENT NEVER ARRIVES. See
        // lib/polar-embed.ts for the checkout that succeeded in silence.
        checkoutId: result.data.id,
        onSuccess: () => {
          /*
           * ⚠ LONGER THAN THE DEFAULT, BECAUSE A NAVIGATION HAPPENS UNDER IT.
           * `reportOutcome` replaces the URL and refreshes the tree a moment
           * later, and at Sonner's default the toast was already fading while
           * the page re-rendered — so the one acknowledgement somebody gets
           * for a payment was gone before they could read it. It has to
           * outlive the refresh it triggers.
           */
          toast.success("Payment received", {
            description: "Setting up your plan — it appears here in a moment.",
          })
          setSubscribed(plan.id)
          onSubscribed?.(plan.id)
          // ⚠ THE BANNER IS THE ACTUAL ANSWER; THE TOAST IS ONLY THE FIRST
          // ACKNOWLEDGEMENT. It polls our own row and says "You're on Pro" when
          // the entitlement is really there — which a toast cannot, because it
          // has already faded by then.
          reportOutcome(result.data.id)
        },
        // ⚠ CLOSED WITHOUT A KNOWN SUCCESS IS NOT THE SAME AS FAILED, AND THE
        // BANNER IS WHAT TELLS THEM APART. It asks our status endpoint, which
        // asks Polar — so a declined card says so, an expired checkout says so,
        // and a payment that went through while the modal was being closed is
        // still reported as the success it was.
        onClose: () => reportOutcome(result.data.id),
      })

      setPending(null)
      return
    } catch {
      // Fall through to the redirect.
    }

    setPending(null)

    // ⚠ A FULL NAVIGATION, NOT `router.push`. Polar is a different origin; the
    // Next router would treat it as a route and fail to resolve it.
    //
    // ⚠ AND `assign()` RATHER THAN ASSIGNING TO `.href`. They do the same thing;
    // the React Compiler refuses the property assignment because it cannot know
    // the object is not React-owned state, and a method call says the same thing
    // without the ambiguity.
    window.location.assign(result.data.url)
  }

  if (plans.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        No plans are published for this workspace.
      </p>
    )
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {plans.map((plan) => {
        const isCurrent = plan.id === currentPlanId
        // ⚠ RANK, NOT PRICE OR NAME. `core.plans.rank` exists precisely so an
        // upgrade can be told from a downgrade without parsing a plan id — see
        // migration 0025, which added it because an in-progress upgrade was
        // being read as a downgrade and deferring a charge.
        const isUpgrade = current !== null && plan.rank > current.rank
        const isDowngrade = current !== null && plan.rank < current.rank
        const leaving = leavingPaidPlan(plan)
        /*
         * ⚠ THE PAID CARD THEY ARE LEAVING IS WHERE THE WAY BACK BELONGS.
         * The free card already says "Ending" with the date; the card for the
         * plan that is about to stop is the one somebody looks at when they
         * change their mind, and it was the one saying "Current plan".
         */
        const resumable = isCurrent && endingAt !== null
        /*
         * ⚠ "Subscribed" IS NOT ONLY ABOUT THIS VISIT. Somebody who paid last
         * week and reopened set-up saw "Continue on Pro" on a plan they are
         * already subscribed to, and the footer still offered to let them
         * come back later — a step presented as outstanding when it was
         * done. The state belongs to the workspace, not to the session that
         * produced it.
         *
         * ⚠ AND ONLY WHERE STAYING PUT IS A STEP, WHICH IS WHAT `onKeep`
         * MARKS. On the billing page the same card is "Current plan" and
         * must stay that way: it is a fact about the account, not the end of
         * anything.
         *
         * ⚠ BUT NEVER WHILE A CANCELLATION IS IN FLIGHT, AND LEAVING THAT
         * OUT BROKE THE WAY BACK. Polar keeps a cancelling subscription
         * `active` until the period ends, so `onPaidPlan` is still true the
         * moment after somebody cancels — and this card went on saying
         * "Subscribed", disabled and green, over a subscription that was
         * expiring. It hid the one control that undoes it.
         */
        const justBought =
          !resumable &&
          (subscribed === plan.id ||
            (onKeep !== undefined && isCurrent && onPaidPlan(billing)))
        const scheduled = scheduledPlanId !== null && plan.id === scheduledPlanId

        return (
          <li
            key={plan.id}
            className={cn(
              "flex flex-col rounded-lg border p-4",
              isCurrent && "border-foreground/40 bg-muted/30",
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">{plan.name}</h3>
              {isCurrent && (
                <span className="text-2xs text-muted-foreground">Current</span>
              )}
            </div>

            <ul className="mt-3 flex-1 space-y-1.5">
              {plan.entitlements.map((entitlement) => (
                <li
                  key={entitlement.featureId}
                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                >
                  <Check
                    className={cn(
                      "mt-0.5 size-3 shrink-0",
                      entitlement.allowance === 0
                        ? "text-muted-foreground/40"
                        : "text-success",
                    )}
                  />
                  {describeEntitlement(entitlement)}
                </li>
              ))}
            </ul>

            <Button
              /*
               * ⚠ "Subscribed" IS NOT DISABLED-LOOKING, THOUGH IT IS
               * DISABLED. A confirmation at half opacity reads as a control
               * that is unavailable rather than as a thing that happened —
               * and this is the one moment in the flow somebody most wants
               * to be told it worked. The opacity is restored and the
               * surface takes the success colour the tick already carries.
               */
              className={cn(
                "mt-4 w-full",
                justBought &&
                  "border-success/30 bg-success/10 text-success disabled:opacity-100",
              )}
              variant={
                isCurrent
                  ? "outline"
                  : leaving && confirming?.id === plan.id
                    ? "destructive"
                    : isUpgrade
                      ? "default"
                      : "outline"
              }
              // ⚠ ALREADY-CANCELLING DISABLES THE FREE CARD RATHER THAN HIDING
              // IT. There is nothing left to ask for — the subscription ends on
              // its own — and a live button would send a second cancel that
              // Polar treats as a no-op, which reads as the first one having
              // failed.
              disabled={
                justBought ||
                (isCurrent && onKeep === undefined && !resumable) ||
                pending !== null ||
                (leaving && endingAt !== null) ||
                scheduled
              }
              onClick={() => {
                if (resumable) return void resume()
                if (isCurrent && onKeep) return onKeep()
                return void choose(plan)
              }}
            >
              {(pending === plan.id || (resumable && pending === RESUMING)) && (
                <Spinner />
              )}
              {label({
                /*
                 * ⚠ RESUMING OUTRANKS "Continue on Pro", because the two say
                 * opposite things about the same card. While a cancellation
                 * is pending, "Continue on Pro" would be a button that ends
                 * the plan anyway at the period boundary.
                 */
                keepLabel: justBought
                  ? "Subscribed"
                  : resumable
                    ? "Keep subscription"
                    : isCurrent && onKeep
                      ? `Continue on ${plan.name}`
                      : null,
                isCurrent,
                isUpgrade,
                isDowngrade,
                leaving,
                ending: endingAt !== null,
                scheduled,
                confirming: confirming?.id === plan.id,
              })}
              {/* ⚠ AFTER THE WORD AND CENTRED WITH IT, as one group. */}
              {justBought && <Check className="text-success" />}
            </Button>

            {/*
             * ⚠ THE DATE IS THE MESSAGE, EXACTLY AS IT IS FOR A CANCELLATION.
             * "Scheduled" on its own invites the question this is supposed to
             * answer — when, and what happens in the meantime.
             */}
            {scheduled && (
              <p className="mt-2 text-xs text-muted-foreground">
                You move here{" "}
                {scheduledAt ? `on ${scheduledAt}` : "at the end of this period"}. Your{" "}
                {current?.name ?? "current"} allowance continues until then.
              </p>
            )}

            {/*
             * ⚠ THE CONSEQUENCE IS SPELLED OUT UNDER THE BUTTON THAT CAUSES IT,
             * not in a dialog that covers the plan being left. The two facts
             * somebody needs are that sending continues and when it stops, and
             * both are short enough to sit here.
             */}
            {leaving && confirming?.id === plan.id && (
              <p className="mt-2 text-xs text-muted-foreground">
                Your {current?.name} allowance continues until the end of the period you
                have paid for. Press again to confirm, or pick another plan.
              </p>
            )}

            {leaving && endingAt !== null && (
              <p className="mt-2 text-xs text-muted-foreground">
                Your subscription already ends on {endingAt}. You move here then.
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * ⚠ THE WORD ON THE BUTTON IS WHAT THE BUTTON DOES. "Downgrade" on the free
 * card was wrong in a way that mattered: it does not move somebody to a cheaper
 * plan, it ends their subscription, and the two have different consequences and
 * different timing. Naming it correctly is most of the fix for "there is
 * nowhere to downgrade or cancel" — the path existed and did not say so.
 */
function label(state: {
  /**
   * ⚠ FIRST, AND IT OUTRANKS EVERY OTHER STATE. Where staying put is an
   * action — the end of onboarding — the card must say what pressing it does.
   * "Current plan" is a label for a control nobody can press.
   */
  keepLabel: string | null
  isCurrent: boolean
  isUpgrade: boolean
  isDowngrade: boolean
  leaving: boolean
  ending: boolean
  scheduled: boolean
  confirming: boolean
}): string {
  if (state.keepLabel !== null) return state.keepLabel
  if (state.isCurrent) return "Current plan"
  // ⚠ BEFORE `leaving`, because a scheduled move to the free plan is both, and
  // "Cancel subscription" on a cancellation that has already been accepted is
  // the wording this whole state exists to stop.
  if (state.scheduled) return "Scheduled"
  if (state.leaving) {
    if (state.ending) return "Ending"
    /*
     * ⚠ "Downgrade", NOT "Cancel subscription", AND THAT IS A REVERSAL OF
     * WHAT THE NOTE ABOVE THIS FUNCTION ARGUES FOR. The argument still
     * stands on the facts — moving to free ENDS the subscription rather than
     * moving between paid plans — but it was reversed deliberately: the free
     * card sits in a row of three identical cards whose other two say
     * "Upgrade" and "Downgrade", and the odd one out read as a different
     * kind of control rather than the same control pointing down.
     *
     * ⚠ THE CONSEQUENCE IS STILL SPELLED OUT, JUST NOT ON THE BUTTON. The
     * second press says "Confirm downgrade", the line beneath the card gives
     * the date the plan actually changes, and the card goes to "Ending" with
     * that date once it is accepted. Nothing about what happens is hidden;
     * only the word on the button changed.
     */
    return state.confirming ? "Confirm downgrade" : "Downgrade"
  }
  if (state.isUpgrade) return "Upgrade"
  if (state.isDowngrade) return "Downgrade"
  return "Choose"
}
