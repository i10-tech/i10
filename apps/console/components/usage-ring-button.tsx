"use client"

import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Meter } from "@repo/ui/components/meter"
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover"
import { UsageRing, usageTone } from "@repo/ui/components/usage-ring"
import { cn } from "cn"

/** One limit, already worded by the server (see usage-rail.tsx). */
export interface RingRow {
  key: string
  label: string
  used: number
  limit: number | null
  overage: boolean
  /** `62 / 100`, or `No daily limit`. */
  amount: string
  /** `Resets in 4 hr 38 min`, `Starts with your next send`, or nothing. */
  detail: string | null
}

const TEXT_TONE = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
} as const

/**
 * The ring, and everything behind it on press (#153).
 *
 * ⚠ A BUTTON, NOT A HOVER CARD. Hover does not exist on a phone and cannot be
 * reached by keyboard the same way; a press opens the same popover everywhere.
 */
export function UsageRingButton({
  rows,
  binding,
  canUpgrade,
}: {
  rows: RingRow[]
  binding: RingRow | null
  canUpgrade: boolean
}) {
  const pct = binding?.limit ? Math.round((binding.used / binding.limit) * 100) : 0
  const tone = binding
    ? usageTone({ used: binding.used, limit: binding.limit, overage: binding.overage })
    : "neutral"

  return (
    <Popover>
      <PopoverTrigger
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-(--duration-instant) ease-(--ease-linear) outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={
          binding
            ? `Usage: ${pct}% of your ${binding.label.toLowerCase()} limit used`
            : "Usage"
        }
      >
        <UsageRing
          used={binding?.used ?? 0}
          limit={binding?.limit ?? null}
          overage={binding?.overage ?? false}
        />
        <span className="text-xs font-medium text-muted-foreground">Usage</span>
        {binding && (
          <span className={cn("tabular ml-auto text-xs", TEXT_TONE[tone])}>{pct}%</span>
        )}
      </PopoverTrigger>

      <PopoverContent side="right" align="end" className="w-72 space-y-4 p-4">
        <p className="text-sm font-medium">Sending limits</p>
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium">{row.label}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {row.amount}
                </span>
              </div>
              {row.limit !== null && (
                <Meter
                  used={row.used}
                  limit={row.limit}
                  overage={row.overage}
                  className="h-1"
                />
              )}
              {row.detail && (
                <p className="text-2xs text-muted-foreground">{row.detail}</p>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <Link
            href="/settings/usage"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Usage details
          </Link>
          {canUpgrade && (
            <Link
              href="/settings/billing"
              className="flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
            >
              Upgrade
              <ArrowUpRight className="size-3" />
            </Link>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
