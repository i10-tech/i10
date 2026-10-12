"use client"

import * as React from "react"
import { LineChart } from "@repo/ui/components/line-chart/line-chart"
import { EmptyState } from "@repo/ui/components/empty-state/empty-state"
import type { WebhookStatsBucket } from "@/lib/types"

const COUNTS = [
  { key: "delivered", label: "Delivered" },
  { key: "pending", label: "Retrying", color: "var(--warning)", area: false },
  { key: "failed", label: "Failed", color: "var(--danger)", area: false },
]

const RATE = [{ key: "rate", label: "Error rate", color: "var(--danger)" }]

function label(iso: string, bucket: "hour" | "day", span: number): string {
  const d = new Date(iso)
  // ⚠ UTC, like every other time on the console's charts: the server and the
  // browser would otherwise disagree about which hour a bar is.
  if (bucket === "day") {
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
  }
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })
  if (span <= 24) return time
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} ${time}`
}

export function StatsCharts({
  series,
  bucket,
}: {
  series: WebhookStatsBucket[]
  bucket: "hour" | "day"
}) {
  const data = React.useMemo(
    () =>
      series.map((s) => {
        const text = label(s.start, bucket, series.length)
        return {
          key: s.start,
          label: text,
          axisLabel: text,
          values: {
            delivered: s.delivered,
            pending: s.pending,
            failed: s.failed,
            rate: s.attempts === 0 ? 0 : (s.failed_attempts / s.attempts) * 100,
          },
        }
      }),
    [series, bucket],
  )

  const empty = series.every(
    (s) => s.delivered + s.failed + s.pending + s.attempts === 0,
  )
  if (empty) {
    return (
      <EmptyState
        title="Nothing sent in this window"
        description="Deliveries and the error rate appear here as events are sent. Send a test event to see one now."
      />
    )
  }

  return (
    <div className="grid gap-8">
      <LineChart
        label="Deliveries, by when they were created"
        data={data}
        series={COUNTS}
        height={220}
        categoryLabel={bucket === "hour" ? "Hour" : "Day"}
        formatValue={(value) => Math.round(value).toLocaleString("en-US")}
      />
      <LineChart
        label="Error rate"
        data={data}
        series={RATE}
        unit="%"
        height={160}
        categoryLabel={bucket === "hour" ? "Hour" : "Day"}
        formatValue={(value) => `${value.toFixed(1)}`}
        formatTick={(value) => `${Math.round(value)}%`}
      />
    </div>
  )
}
