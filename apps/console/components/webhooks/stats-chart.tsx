"use client"

import * as React from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@repo/ui/components/chart"
import { formatErrorRate } from "@/lib/webhooks"
import type { WebhookStatsBucket } from "@/lib/types"

/**
 * Deliveries and the error rate over the window, as two charts on one time
 * axis.
 *
 * ⚠ TWO CHARTS, NOT ONE WITH TWO Y-AXES. Counts and a percentage have
 * nothing in common in scale, and a second axis invites reading where the
 * lines cross as meaning something. Stacked, they line up by step instead.
 *
 * ⚠ THE COLOURS ARE THE STATE TOKENS, as on the overview: delivered is the
 * neutral bulk, failed red, pending blue. A chart with its own palette would
 * mean learning a legend the rest of the console already taught.
 */
const COUNTS = {
  delivered: { label: "Delivered", color: "var(--color-chart-2)" },
  pending: { label: "Retrying", color: "var(--color-info)" },
  failed: { label: "Failed", color: "var(--color-danger)" },
} satisfies ChartConfig

const RATE = {
  rate: { label: "Error rate", color: "var(--color-danger)" },
} satisfies ChartConfig

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
      series.map((s) => ({
        label: label(s.start, bucket, series.length),
        delivered: s.delivered,
        pending: s.pending,
        failed: s.failed,
        // ⚠ NULL, NOT ZERO, FOR A STEP WITH NO ATTEMPTS. A gap in the line is
        // "nothing was sent"; a zero would claim everything that was sent
        // worked.
        rate: s.attempts === 0 ? null : (s.failed_attempts / s.attempts) * 100,
        attempts: s.attempts,
      })),
    [series, bucket],
  )

  const empty = series.every(
    (s) => s.delivered + s.failed + s.pending + s.attempts === 0,
  )
  if (empty) {
    return (
      <div className="flex h-[240px] flex-col items-center justify-center gap-1 rounded-2xl border border-dashed text-center">
        <p className="text-sm font-medium">Nothing sent in this window</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Deliveries and the error rate appear here as events are sent. Send a test
          event to see one now.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <figure>
        <figcaption className="mb-2 text-xs font-medium text-muted-foreground">
          Deliveries, by when they were created
        </figcaption>
        <ChartContainer config={COUNTS} className="h-[220px] w-full">
          <BarChart
            data={data}
            margin={{ left: 4, right: 4, top: 8 }}
            barCategoryGap={2}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              className="text-2xs"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={36}
              allowDecimals={false}
              className="text-2xs"
            />
            <ChartTooltip
              cursor={{ fillOpacity: 0.4 }}
              content={<ChartTooltipContent />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar
              dataKey="delivered"
              stackId="d"
              fill="var(--color-delivered)"
              fillOpacity={0.5}
              isAnimationActive={false}
            />
            <Bar
              dataKey="pending"
              stackId="d"
              fill="var(--color-pending)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="failed"
              stackId="d"
              fill="var(--color-failed)"
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      </figure>

      <figure>
        <figcaption className="mb-2 text-xs font-medium text-muted-foreground">
          Error rate: failed attempts over attempts, retries included
        </figcaption>
        <ChartContainer config={RATE} className="h-[140px] w-full">
          <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              className="text-2xs"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={36}
              domain={[0, (max: number) => Math.max(5, Math.ceil(max))]}
              tickFormatter={(v: number) => `${v}%`}
              className="text-2xs"
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => (
                    <span className="flex w-full justify-between gap-4">
                      <span className="text-muted-foreground">Error rate</span>
                      <span className="tabular font-mono">
                        {formatErrorRate(Number(value) / 100)}
                      </span>
                    </span>
                  )}
                />
              }
            />
            <Area
              dataKey="rate"
              type="monotone"
              stroke="var(--color-rate)"
              strokeWidth={2}
              fill="var(--color-rate)"
              fillOpacity={0.12}
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      </figure>
    </div>
  )
}
