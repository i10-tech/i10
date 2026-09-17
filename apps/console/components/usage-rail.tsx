import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Meter } from "@repo/ui/components/meter"
import { tryApi } from "@/lib/api"
import { formatCompact, formatDay } from "@/lib/format"
import type { BillingState, FeatureUsage } from "@/lib/types"

/**
 * Sending volume against the plan, pinned to the bottom of the sidebar.
 *
 * ⚠ IT IS ON EVERY SCREEN ON PURPOSE. Metering that lives only on a billing
 * page is metering nobody looks at until a send is refused — at which point the
 * first they know of a limit is a 403 in production. A bar in the corner is the
 * cheapest possible way to make the number ambient, and it is also the only
 * permanent home the upgrade button has.
 *
 * ⚠ IT SHOWS `emails` AND ONLY `emails`. The usage page lists all five metered
 * features; a rail with five bars in it is a second navigation nobody asked for,
 * and four of those five change about once a month.
 *
 * ⚠ AND A FAILURE HERE RENDERS NOTHING RATHER THAN AN ERROR. This is ambient
 * furniture on every page in the console; a red box in the corner of all of them
 * because the meter had a bad second would be the most alarming possible way to
 * report the least important possible failure.
 */
export async function UsageRail() {
  const result = await tryApi<{ usage: FeatureUsage[]; billing: BillingState }>(
    "/console/usage",
  )

  if (!result.ok) return null

  const emails = result.data.usage.find((u) => u.feature_id === "emails")
  if (!emails || emails.status !== "ok") return null

  const plan = result.data.billing.plan
  // ⚠ THE UPGRADE PROMPT IS SHOWN ON THE LOWEST-RANKED PLAN, NOT ON "free" BY
  // NAME. Plan ids are catalogue data and a tenant can be on a bespoke one; a
  // hard-coded string would stop working the first time somebody is given a
  // custom plan, silently, by never offering them an upgrade again.
  const canUpgrade = plan === null || plan.rank === 0

  return (
    <div className="space-y-2 rounded-md px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Emails</span>
        <span className="tabular text-xs text-muted-foreground">
          <span className="text-foreground">{formatCompact(emails.used)}</span>
          {emails.allowance !== null && ` / ${formatCompact(emails.allowance)}`}
        </span>
      </div>

      <Meter
        used={emails.used}
        limit={emails.allowance}
        overage={emails.overage}
        className="h-1"
      />

      {emails.resets_at && (
        <p className="text-2xs text-muted-foreground">
          {/*
            ⚠ `formatDay` ON THE UTC CALENDAR DAY, NOT `toLocaleDateString` WITH
            AN IMPLICIT LOCALE. This renders on the server, where the locale is
            the container's — `undefined` means "whatever ICU defaults to",
            which is not the reader's — and the timezone is UTC, so a reset at
            `2026-10-01T00:00:00Z` printed in local time reads as 30 Sep for
            everybody west of Greenwich. One day early on the number people
            budget against.
          */}
          Resets {formatDay(emails.resets_at.slice(0, 10))}
        </p>
      )}

      {canUpgrade && (
        <Link
          href="/settings/billing"
          className="flex items-center gap-1 pt-0.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          Upgrade
          <ArrowUpRight className="size-3" />
        </Link>
      )}
    </div>
  )
}
