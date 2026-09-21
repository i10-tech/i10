"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Check } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { changePlan, startCheckout } from "@/lib/actions"
import { openPolarCheckout } from "@/lib/polar-embed"
import { formatBytes, formatNumber } from "@/lib/format"
import type { PlanSummary } from "@/lib/types"

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

export function PlanCards({
  plans,
  currentPlanId,
  hasSubscription,
  endingAt = null,
  scheduledPlanId = null,
  scheduledAt = null,
}: {
  plans: PlanSummary[]
  currentPlanId: string | null
  hasSubscription: boolean
  /**
   * ⚠ SET WHEN THE SUBSCRIPTION IS ALREADY CANCELLING. Without it the free card
   * keeps offering "Cancel subscription" to somebody who has already cancelled,
   * and pressing it a second time looks like the first press did nothing.
   */
  endingAt?: string | null
  /**
   * The plan a deferred change is already moving to, and when.
   *
   * ⚠ THE SAME PROBLEM `endingAt` SOLVES, FOR THE OTHER KIND OF DEFERRED
   * CHANGE. A downgrade is applied at the period boundary, so the card for the
   * plan they are moving TO still reads "Downgrade" and is still pressable —
   * and pressing it sends a second PATCH that supersedes an identical pending
   * update. Nothing changes, no error appears, and the only reading available
   * is that the button does not work.
   */
  scheduledPlanId?: string | null
  scheduledAt?: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { resolvedTheme } = useTheme()
  const [pending, setPending] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<PlanSummary | null>(null)

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
      router.replace(`${here}?${params.toString()}`)
      // The banner is client-side, but the plan above it is not — this is what
      // makes "Current plan" catch up once the grant lands.
      router.refresh()
    },
    [pathname, router],
  )

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
          toast.success("Payment received", {
            description: "Setting up your plan — it appears here in a moment.",
          })
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
              className="mt-4 w-full"
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
                isCurrent ||
                pending !== null ||
                (leaving && endingAt !== null) ||
                scheduled
              }
              onClick={() => choose(plan)}
            >
              {pending === plan.id && <Spinner />}
              {label({
                isCurrent,
                isUpgrade,
                isDowngrade,
                leaving,
                ending: endingAt !== null,
                scheduled,
                confirming: confirming?.id === plan.id,
              })}
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
  isCurrent: boolean
  isUpgrade: boolean
  isDowngrade: boolean
  leaving: boolean
  ending: boolean
  scheduled: boolean
  confirming: boolean
}): string {
  if (state.isCurrent) return "Current plan"
  // ⚠ BEFORE `leaving`, because a scheduled move to the free plan is both, and
  // "Cancel subscription" on a cancellation that has already been accepted is
  // the wording this whole state exists to stop.
  if (state.scheduled) return "Scheduled"
  if (state.leaving) {
    if (state.ending) return "Ending"
    return state.confirming ? "Confirm cancellation" : "Cancel subscription"
  }
  if (state.isUpgrade) return "Upgrade"
  if (state.isDowngrade) return "Downgrade"
  return "Choose"
}
