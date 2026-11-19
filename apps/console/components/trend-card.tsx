"use client"

import * as React from "react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Sparkline } from "@repo/ui/components/sparkline/sparkline"

const DAY = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

export interface TrendCardProps {
  label: string
  value?: number
  points?: number[]
  /** `YYYY-MM-DD`, one per point. */
  dates?: string[]
  context: string
  /** The text is made from the numbers ("99.3% of sent"), so it is a bone until they arrive. */
  derived?: boolean
  warning?: string
  loading?: boolean
}

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
  derived = false,
  warning,
  loading: loadingProp,
}: {
  label: string
  value?: number
  points?: number[]
  /** `YYYY-MM-DD`, one per point. */
  dates?: string[]
  context: string
  derived?: boolean
  warning?: string
  loading?: boolean
}) {
  const isLoaded =
    !loadingProp && value !== undefined && points !== undefined && dates !== undefined
  const loading = !isLoaded
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-")

  return (
    <BoneScope id={`trend-${id}`} loading={loading}>
      <div className="i10-surface i10-trend @container flex min-w-0 flex-col gap-2 rounded-[var(--radius-panel)] border bg-card p-4">
        {isLoaded ? (
          <Bone id="chart" shape="box" width="100%" height={48} radius={8}>
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
          </Bone>
        ) : (
          <>
            {/*
             * ⚠ SKIPPED BY test/skeleton-parity: loaded, the Sparkline draws this
             * label and value itself, inside the chart's bone.
             *
             * ⚠ THIS ROW AND THE BONE BELOW ARE THE SPARKLINE'S FIGURE, TO THE
             * PIXEL (2026-11-09): its caption is 25.5px (the 17px value at 1.5),
             * 12px above a plot that is the card's width at 220:48. `mb-1` makes
             * the card's 8px gap the figure's 12px. Drawn as a 20px row and a 48px
             * bar, every card grew ~35px when its data arrived.
             */}
            <div
              data-skeleton="skip"
              className="mb-1 flex min-h-[25.5px] min-w-0 items-baseline justify-between gap-2 text-sm"
            >
              <span className="min-w-0 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
                {label}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Bone id="value" width={56} lineHeight={20} inline align="end" />
                {warning !== undefined && (
                  <Bone
                    id="delta"
                    shape="box"
                    width={48}
                    height={18}
                    radius={9999}
                    inline
                  />
                )}
              </div>
            </div>
            {/* The plot's height follows the card's width (100cqw), as the Sparkline's does; the `!` lets the bone's spans take it over their inline px. */}
            <Bone
              id="chart"
              shape="box"
              width="100%"
              height={48}
              radius={8}
              className="h-[calc(100cqw*48/220)] [&_span]:h-full!"
            />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          {derived ? (
            <Bone id="context" width={96} lineHeight={16}>
              {context}
            </Bone>
          ) : (
            context
          )}
        </p>
      </div>
    </BoneScope>
  )
}
