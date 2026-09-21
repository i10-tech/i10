import type { BillingState } from "@/lib/types"

/**
 * The subscription states that can still be amended, and the one question
 * every control on a plan card is really asking.
 *
 * ⚠ "HAS A SUBSCRIPTION ROW" IS NOT THE SAME QUESTION, AND READING IT AS ONE
 * BROKE UPGRADING. `core.subscriptions` keeps the row through a cancellation —
 * it is the history — so `billing.subscription !== null` stays true for
 * somebody whose subscription ended. Every card then took the amend path:
 * "Upgrade" called `changePlan`, the API refused because there is nothing at
 * Polar left to change, and the console reported "Start a checkout to
 * subscribe before changing plan" — instructions, offered as an error, for
 * the thing the button was supposed to have done.
 *
 * ⚠ IT MIRRORS `LIVE` IN THE API'S plan-change.ts, DELIBERATELY AND NOT BY
 * IMPORT. Two runtimes, two bundles; the contract between them is the status
 * string, which is Polar's. If one list changes the other has to, and the
 * symptom of them disagreeing is this bug in one direction or a checkout that
 * buys a second subscription in the other.
 *
 * ⚠ `past_due` COUNTS AS LIVE. The subscription exists and Polar will amend
 * it; sending somebody to checkout there would leave the failing one running
 * beside whatever they bought.
 */
const LIVE = new Set(["active", "trialing", "past_due"])

/** Whether there is a subscription to amend, rather than one to remember. */
export function hasLiveSubscription(billing: BillingState): boolean {
  return billing.subscription !== null && LIVE.has(billing.subscription.status)
}

/**
 * Whether the workspace is on a PAID plan right now.
 *
 * ⚠ RANK, NOT THE PLAN ID. `free` is rank 0 by construction — see migration
 * 0025, which added the column so an upgrade could be told from a downgrade
 * without parsing ids — and hard-coding the string here would be a second
 * definition of "free" that a renamed plan would silently break.
 *
 * ⚠ AND IT NEEDS THE SUBSCRIPTION TO BE LIVE, not merely present. A workspace
 * whose Pro subscription lapsed is granted the free allowance and is not on a
 * paid plan, however recently it was.
 */
export function onPaidPlan(billing: BillingState): boolean {
  return hasLiveSubscription(billing) && (billing.plan?.rank ?? 0) > 0
}
