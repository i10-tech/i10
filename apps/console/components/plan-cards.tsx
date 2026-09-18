"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Check } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { changePlan, startCheckout } from "@/lib/actions"
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
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, setPending] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<PlanSummary | null>(null)

  const current = plans.find((plan) => plan.id === currentPlanId) ?? null

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

    const result = await startCheckout(plan.id)

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
      const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed")
      const checkout = await PolarEmbedCheckout.create(result.data.url, {
        theme: resolvedTheme === "light" ? "light" : "dark",
      })

      setPending(null)

      /*
       * ⚠ THE OVERLAY IS CLOSED EXPLICITLY, AND NOT CLOSING IT WAS THE BUG.
       * Polar locks the embed closed on its `confirmed` event — deliberately,
       * so nobody navigates away mid-charge — and only re-opens it on
       * `success`. This listener refreshed the page BEHIND the iframe and
       * returned, so the customer was left looking at Polar's post-payment
       * frame with no way out of it: payment taken, console updated underneath,
       * and a modal on top saying it was waiting for confirmation. Reloading
       * by hand was the only escape, and it showed the plan already granted.
       *
       * ⚠ `close()` RATHER THAN LEAVING IT TO THE DEFAULT HANDLER. The default
       * only re-enables closing and redirects when Polar asks for a redirect —
       * which it does not when the checkout has no success URL configured. That
       * makes whether the modal ever goes away depend on an environment
       * variable, which is not a thing the customer should be able to feel.
       */
      checkout.addEventListener("success", () => {
        checkout.close()
        toast.success("Payment received", {
          description: "Your new allowances appear as soon as it clears.",
        })
        // ⚠ AND THE PAGE IS REFRESHED AFTER THE CLOSE, NOT INSTEAD OF IT. The
        // plan moves when Polar's webhook lands, a second or two later, so this
        // is a best effort — the wording above is written for somebody whose
        // allowance has not moved yet.
        router.refresh()
      })
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
              disabled={isCurrent || pending !== null || (leaving && endingAt !== null)}
              onClick={() => choose(plan)}
            >
              {pending === plan.id && <Spinner />}
              {label({
                isCurrent,
                isUpgrade,
                isDowngrade,
                leaving,
                ending: endingAt !== null,
                confirming: confirming?.id === plan.id,
              })}
            </Button>

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
  confirming: boolean
}): string {
  if (state.isCurrent) return "Current plan"
  if (state.leaving) {
    if (state.ending) return "Ending"
    return state.confirming ? "Confirm cancellation" : "Cancel subscription"
  }
  if (state.isUpgrade) return "Upgrade"
  if (state.isDowngrade) return "Downgrade"
  return "Choose"
}
