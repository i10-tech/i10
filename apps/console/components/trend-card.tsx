"use client"

import { Sparkline } from "@repo/ui/components/sparkline/sparkline"

const DAY = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

/**
 * A headline number with its trend under it: Arc's Sparkline in a card, one
 * point per day of the range. Scrubbing the line shows each day's count and
 * date in the headline.
 *
 * ⚠ TONED ONLY WHEN SOMETHING NEEDS DOING. `warning` is the threshold that
 * crossed ("Over 4%"); without one the line is the quiet accent, because a
 * red line for bounces that are fine teaches people to ignore red.
 */
export function TrendCard({
  label,
  value,
  points,
  dates,
  context,
  warning,
}: {
  label: string
  value: number
  points: number[]
  /** `YYYY-MM-DD`, one per point. */
  dates: string[]
  context: string
  warning?: string
}) {
  return (
    <div className="i10-surface i10-trend flex min-w-0 flex-col gap-2 rounded-[var(--radius-panel)] border bg-card p-4">
      <Sparkline
        label={label}
        value={value.toLocaleString("en")}
        change={warning}
        tone={warning ? "danger" : "accent"}
        data={points}
        labels={dates.map((d) => DAY.format(new Date(`${d}T00:00:00Z`)))}
        formatValue={(n) => n.toLocaleString("en")}
        width={220}
        height={48}
      />
      <p className="text-xs text-muted-foreground">{context}</p>
    </div>
  )
}
