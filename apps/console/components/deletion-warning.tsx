import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert"
import { formatExact } from "@/lib/format"
import type { BillingState } from "@/lib/types"

/**
 * What deleting actually does to the bill, said before the button that does it.
 *
 * ⚠ IT SITS BESIDE CLERK'S PANEL BECAUSE IT CANNOT SIT INSIDE IT. "Delete
 * account" and "Delete organization" are rendered by `<UserProfile />` and
 * `<OrganizationProfile />`, whose confirmation dialogs are Clerk's own and
 * take no copy from us. Their wording is about identity — the account, the
 * members, the sessions — and says nothing about money, because Clerk has no
 * idea there is any. The consequence that actually costs something therefore
 * has to be stated next to the panel, where somebody reads it on the way in.
 *
 * ⚠ AND IT IS A PROMISE THE SYSTEM NOW KEEPS. Deleting used to leave the
 * subscription running: the tenant stayed `active`, the plan assignment stayed
 * on Pro, and Polar went on charging the card every month for a workspace
 * nobody could sign in to. `organization.deleted` now revokes it immediately —
 * see apps/api/src/tenants/lifecycle.ts — so this says "immediately" because
 * that is what happens, not as a deterrent.
 *
 * ⚠ THE DATE IS NAMED WHEN THERE IS ONE, because "you lose the rest of the
 * period" is abstract and "you lose the 19 days you have paid for" is a
 * decision. This is the one place in the product where a downgrade is NOT
 * deferred to the period end, and somebody with three weeks left should be told
 * that in those terms.
 */
export function DeletionWarning({
  billing,
  scope,
}: {
  billing: BillingState | null
  /** Whose deletion this sits next to. The consequences differ. */
  scope: "account" | "workspace"
}) {
  const paid = billing?.subscription ?? null
  const endsAt = paid?.current_period_end

  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>
        {paid
          ? "Deleting ends your subscription immediately"
          : "Deleting cannot be undone"}
      </AlertTitle>
      <AlertDescription>
        {paid ? (
          <p>
            Your {billing?.plan?.name ?? "paid"} subscription is cancelled the moment
            this workspace is deleted — not at the end of the period.{" "}
            {endsAt
              ? `You lose the time you have already paid for, through to ${formatExact(endsAt)}, and it is not refunded.`
              : "You lose the remainder of the period you have already paid for, and it is not refunded."}{" "}
            Sending, mailboxes and allowances stop at the same moment.
          </p>
        ) : (
          <p>
            There is no subscription to cancel — you are on the included allowance.
            Deleting still removes the workspace, its domains and its mailboxes for
            good.
          </p>
        )}

        {/*
         * ⚠ THE WAY OUT IS NAMED, BECAUSE MOST PEOPLE HERE WANT THE OTHER
         * THING. Somebody who means "stop charging me" is one page away from
         * cancelling, which keeps their plan to the end of the period they paid
         * for and keeps their data. Deleting to achieve that costs them both.
         */}
        {paid && (
          <p>
            To stop being charged without losing any of this, cancel the subscription on
            the billing page instead — it runs to{" "}
            {endsAt ? formatExact(endsAt) : "the end of the period"} and then drops to
            the free allowance.
          </p>
        )}

        {scope === "account" && (
          <p>
            Deleting your account also deletes any workspace you are the only member of.
            A workspace with other people in it is left alone.
          </p>
        )}
      </AlertDescription>
    </Alert>
  )
}
