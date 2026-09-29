import { tryApi } from "@/lib/api"
import { formatNumber, formatUntil } from "@/lib/format"
import type { BillingState, FeatureUsage, SendingLimit } from "@/lib/types"
import { UsageRingButton, type RingRow } from "@/components/usage-ring-button"

/**
 * Sending usage as a ring, pinned to the bottom of the sidebar (#153).
 *
 * ⚠ IT IS ON EVERY SCREEN ON PURPOSE. Metering that lives only on a billing
 * page is metering nobody looks at until a send is refused. A ring in the
 * corner keeps the number ambient in the space of an icon; pressing it gives
 * every limit, when each resets, and the upgrade link.
 *
 * ⚠ THE RING SHOWS THE LIMIT THAT BINDS FIRST - whichever is closest to full.
 * A free workspace has a day and a month, and either can refuse the next send;
 * a ring for the day alone would read green on the morning the month runs out.
 *
 * ⚠ THE TEXT IS COMPUTED HERE, ON THE SERVER. "Resets in 4 hr 38 min" depends
 * on the clock, and computing it again in the browser would disagree with this
 * render and discard it.
 *
 * ⚠ AND A FAILURE HERE RENDERS NOTHING RATHER THAN AN ERROR. This is ambient
 * furniture on every page; a red box in all of them because the meter had a
 * bad second would be the loudest possible report of the least important
 * failure.
 */
export async function UsageRail() {
  const result = await tryApi<{
    usage: FeatureUsage[]
    limits: SendingLimit[]
    billing: BillingState
  }>("/console/usage")
  if (!result.ok) return null

  const { limits, billing } = result.data
  const rows: RingRow[] = limits
    .filter((l) => l.status === "ok")
    .map((l) => ({
      key: `${l.window}:${l.count}`,
      label: LABEL[l.window] ?? l.window,
      used: l.used,
      limit: l.allowance,
      overage: l.overage,
      amount:
        l.allowance === null
          ? `No ${(LABEL[l.window] ?? l.window).toLowerCase()} limit`
          : `${formatNumber(l.used)} / ${formatNumber(l.allowance)}`,
      detail: l.starts_on_send
        ? "Starts with your next send"
        : l.resets_at
          ? `Resets in ${formatUntil(l.resets_at)}`
          : null,
    }))
  if (rows.length === 0) return null

  // The binding limit: the highest share used among the ones that limit.
  const binding =
    rows
      .filter((r) => r.limit !== null && r.limit > 0)
      .sort((a, b) => b.used / b.limit! - a.used / a.limit!)[0] ?? null

  // ⚠ THE UPGRADE PROMPT FOLLOWS THE LOWEST-RANKED PLAN, NOT "free" BY NAME.
  // Plan ids are catalogue data and a tenant can be on a bespoke one.
  const plan = billing.plan
  const canUpgrade = plan === null || plan.rank === 0

  return <UsageRingButton rows={rows} binding={binding} canUpgrade={canUpgrade} />
}

const LABEL: Record<string, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
  lifetime: "Lifetime",
}
