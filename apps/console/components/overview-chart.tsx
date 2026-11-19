"use client"

import * as React from "react"
import { Bone } from "@repo/ui/components/bone/bone"
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

export function OverviewChart({
  series,
  loading = false,
}: {
  series?: DailyStat[]
  loading?: boolean
}) {
  const data = React.useMemo(
    () =>
      series?.map((d) => ({
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
      })) ?? [],
    [series],
  )

  const empty = React.useMemo(
    () =>
      !series || series.every((d) => d.sent + d.delivered + d.bounced + d.failed === 0),
    [series],
  )

  // ⚠ EVERY STATE IS INSIDE THE ONE BONE, the empty one too: whether a window
  // has any mail is the data's, and a shape does not carry it.
  //
  // ⚠ 314, NOT THE CHART'S 240: LineChart's `height` is its plot alone; its
  // legend and axis make the figure 314px, so a 240px bone made the section
  // (and everything under it) jump 74px when the data arrived (2026-11-09).
  const drawn = !loading && series !== undefined
  return (
    <Bone id="chart" shape="box" width="100%" height={314} radius={8} loading={!drawn}>
      {drawn &&
        (empty ? (
          <EmptyState
            title="No mail in this window"
            description="Delivery, bounces and complaints appear here once you start sending."
          />
        ) : (
          <LineChart
            label="Delivery"
            data={data}
            series={SERIES}
            height={240}
            formatValue={(value) => Math.round(value).toLocaleString("en-US")}
            defaultHiddenSeries={["delayed"]}
          />
        ))}
    </Bone>
  )
}
