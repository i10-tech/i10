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
}: {
  plans: PlanSummary[]
  currentPlanId: string | null
  hasSubscription: boolean
}) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const [pending, setPending] = React.useState<string | null>(null)

  const current = plans.find((plan) => plan.id === currentPlanId) ?? null

  async function choose(plan: PlanSummary) {
    if (pending) return
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
       */
      toast.success("Plan change requested", {
        description: "Your allowances move as soon as the payment clears.",
      })
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

      // ⚠ REFRESHED ON `success`, NOT ON `close`. The plan moves when Polar's
      // webhook lands, which is a second or two after the customer sees a
      // confirmation — so the refresh is a best effort and the message is
      // worded for somebody whose plan has not updated yet.
      checkout.addEventListener("success", () => {
        toast.success("Payment received", {
          description: "Your new allowances appear as soon as it clears.",
        })
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
              variant={isCurrent ? "outline" : isUpgrade ? "default" : "outline"}
              disabled={isCurrent || pending !== null}
              onClick={() => choose(plan)}
            >
              {pending === plan.id && <Spinner />}
              {isCurrent
                ? "Current plan"
                : isUpgrade
                  ? "Upgrade"
                  : isDowngrade
                    ? "Downgrade"
                    : "Choose"}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
