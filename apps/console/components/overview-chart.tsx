"use client"

import * as React from "react"
import { LineChart } from "@repo/ui/components/line-chart/line-chart"
import { EmptyState } from "@repo/ui/components/empty-state/empty-state"
import { formatDay } from "@/lib/format"
import type { DailyStat } from "@/lib/types"

/**
 * Delivery outcomes per day: Arc's LineChart. Delivered is the one series that
 * matters and carries the area; the outcomes that need attention take their
 * status colour, so a red line always means mail came back.
 */
const SERIES = [
  { key: "delivered", label: "Delivered" },
  { key: "bounced", label: "Bounced", color: "var(--danger)", area: false },
  { key: "complained", label: "Complained", color: "var(--warning)", area: false },
  {
    key: "delayed",
    label: "Delayed",
    color: "var(--text-muted)",
    dashed: true,
    area: false,
  },
  { key: "failed", label: "Failed", color: "var(--danger)", dashed: true, area: false },
]

export function OverviewChart({ series }: { series: DailyStat[] }) {
  const data = React.useMemo(
    () =>
      series.map((d) => ({
        key: d.date,
        label: formatDay(d.date),
        axisLabel: formatDay(d.date),
        values: {
          delivered: d.delivered,
          bounced: d.bounced,
          complained: d.complained,
          delayed: d.delayed,
          failed: d.failed,
        },
      })),
    [series],
  )

  const empty = React.useMemo(
    () => series.every((d) => d.sent + d.delivered + d.bounced + d.failed === 0),
    [series],
  )

  if (empty) {
    return (
      <EmptyState
        title="No mail in this window"
        description="Delivery, bounces and complaints appear here once you start sending."
      />
    )
  }

  return (
    <LineChart
      label="Delivery"
      data={data}
      series={SERIES}
      height={240}
      formatValue={(value) => Math.round(value).toLocaleString("en-US")}
      defaultHiddenSeries={["delayed"]}
    />
  )
}
