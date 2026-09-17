"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@repo/ui/components/chart"
import { formatDay } from "@/lib/format"
import type { DailyStat } from "@/lib/types"

/**
 * Delivery over time.
 *
 * ⚠ THE SERIES ARE THE STATE TOKENS, NOT A CATEGORICAL PALETTE, AND THAT IS
 * WHAT MAKES THE CHART READABLE AT A GLANCE. Bounced is the same red here as
 * the badge in the log and the dot on the detail page; a chart with its own
 * colour scheme would mean learning the legend before the picture means
 * anything. `delivered` is deliberately the neutral foreground rather than
 * green — it is the bulk of every series, and a wall of green makes the small
 * red area impossible to find, which is the one thing somebody is looking for.
 *
 * ⚠ AND IT IS STACKED, BECAUSE THE SERIES ARE MUTUALLY EXCLUSIVE OUTCOMES OF
 * ONE SEND. Overlaid areas would let `delivered` hide `bounced` completely
 * behind it for any tenant whose mail mostly works — which is all of them, and
 * is precisely when a bounce matters most.
 */
const CONFIG = {
  delivered: { label: "Delivered", color: "var(--color-chart-2)" },
  delayed: { label: "Delayed", color: "var(--color-warning)" },
  complained: { label: "Complained", color: "var(--color-warning)" },
  bounced: { label: "Bounced", color: "var(--color-danger)" },
  failed: { label: "Failed", color: "var(--color-danger)" },
} satisfies ChartConfig

export function OverviewChart({ series }: { series: DailyStat[] }) {
  /*
   * ⚠ THE X LABEL IS PRECOMPUTED, NOT FORMATTED IN A TICK CALLBACK. Recharts
   * calls the formatter on every render of every tick; doing date maths there
   * is thousands of `Intl` constructions during a resize. It also keeps the
   * UTC handling in one place — see `formatDay` on why parsing `YYYY-MM-DD`
   * naively renders the wrong day west of Greenwich.
   */
  const data = React.useMemo(
    () => series.map((d) => ({ ...d, label: formatDay(d.date) })),
    [series],
  )

  const empty = React.useMemo(
    () => series.every((d) => d.sent + d.delivered + d.bounced + d.failed === 0),
    [series],
  )

  if (empty) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center">
        <p className="text-sm font-medium">No mail in this window</p>
        <p className="text-xs text-muted-foreground">
          Delivery, bounces and complaints appear here once you start sending.
        </p>
      </div>
    )
  }

  return (
    <ChartContainer config={CONFIG} className="h-[260px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        {/*
         * ⚠ HORIZONTAL LINES ONLY. Vertical gridlines on a time axis add one
         * rule per day — thirty of them — to a chart whose whole job is the
         * shape of a curve. The date labels already carry the x positions.
         */}
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          className="text-2xs"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          // ⚠ INTEGER TICKS. A count of emails has no meaningful 0.5, and
          // recharts will happily produce one on a chart whose maximum is 3.
          allowDecimals={false}
          className="text-2xs"
        />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
        <ChartLegend content={<ChartLegendContent />} />

        {/*
         * ⚠ ONLY `delivered` CARRIES A STROKE, AND THE OTHER FOUR ARE SOLID
         * FILLS WITH NONE. This is not a style preference — it is the fix for a
         * chart that read as a single red line. Bounces and failures are two
         * orders of magnitude smaller than deliveries, so when they are stacked
         * on top their curves sit within a pixel or two of the delivered curve;
         * every one of their strokes then draws over it, and the topmost —
         * `failed`, red — is the only one you see. Dropping their strokes lets
         * the neutral delivered line stay the shape of the chart.
         *
         * ⚠ AND THEIR FILL IS NEARLY OPAQUE WHILE `delivered` IS A WASH. At this
         * ratio a 0.18 fill on a three-pixel band is invisible, which would make
         * the one thing worth spotting the thing you cannot see. The bad days
         * read as a thin solid stripe along the top of the volume.
         */}
        <Area
          dataKey="delivered"
          type="monotone"
          stackId="outcome"
          stroke="var(--color-delivered)"
          fill="var(--color-delivered)"
          fillOpacity={0.15}
          strokeWidth={1.5}
          // ⚠ DOTS OFF. Thirty days at one dot per day is thirty circles
          // competing with the line; the active dot on hover is the one that
          // carries information.
          dot={false}
          // ⚠ ANIMATION OFF. The chart re-renders when the date range changes,
          // and animating a stacked area from its old shape to a completely
          // different dataset is a half-second of meaningless morphing. Base's
          // rules call that motion with no purpose.
          isAnimationActive={false}
        />

        {(["delayed", "complained", "bounced", "failed"] as const).map((key) => (
          <Area
            key={key}
            dataKey={key}
            type="monotone"
            stackId="outcome"
            stroke="none"
            fill={`var(--color-${key})`}
            fillOpacity={0.85}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}
