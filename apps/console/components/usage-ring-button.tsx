"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Meter } from "@repo/ui/components/meter"
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover"
import { UsageRing } from "@repo/ui/components/usage-ring"
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

/**
 * The ring, and every limit behind it on press (#153).
 *
 * ⚠ THE RING ALONE, NO WORD AND NO PERCENTAGE. It sits at the right of the
 * account row (account-bar.tsx); its colour says whether to look, and pressing
 * it says everything else. The number it used to print next to it was the
 * popover's first line said twice.
 *
 * ⚠ A BUTTON, NOT A HOVER CARD. Hover does not exist on a phone and cannot be
 * reached by keyboard the same way; a press opens the same popover everywhere.
 *
 * ⚠ CONTROLLED, SO FOLLOWING A LINK CLOSES IT. A Radix popover closes on an
 * outside press or Escape, not when something inside it navigates - and in an
 * app shell the rail does not unmount on navigation, so "Usage details" used
 * to take you to the page with the popover still hanging over it.
 */
export function UsageRingButton({
  rows,
  binding,
  canUpgrade,
  side = "right",
}: {
  rows: RingRow[]
  binding: RingRow | null
  canUpgrade: boolean
  /**
   * `right` beside the desktop rail, as Claude's does; `top` in the mobile
   * drawer, where there is no room to the right of a 288px sheet.
   */
  side?: "right" | "top"
}) {
  const [open, setOpen] = React.useState(false)
  const close = () => setOpen(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md outline-none",
          "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
          "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
        )}
        aria-label={ringLabel(binding)}
      >
        <UsageRing
          used={binding?.used ?? 0}
          limit={binding?.limit ?? null}
          overage={binding?.overage ?? false}
        />
      </PopoverTrigger>

      <PopoverContent
        side={side}
        align="end"
        sideOffset={side === "right" ? 12 : 6}
        className="w-72 space-y-4 p-4"
      >
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
            onClick={close}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Usage details
          </Link>
          {canUpgrade && (
            <Link
              href="/settings/billing"
              onClick={close}
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

/**
 * What a screen reader hears for the ring: the binding limit in plain counts.
 *
 * ⚠ COUNTS, NOT A PERCENTAGE (decided 2026-09-29). "62 of 100 daily emails
 * used" is the sentence on the usage page; "62%" makes the listener do the
 * arithmetic backwards. The other limits are one press away, in the popover.
 */
export function ringLabel(binding: RingRow | null): string {
  if (!binding || binding.limit === null) return "Sending limits"
  const period = binding.label.toLowerCase()
  return `Sending limits: ${binding.used.toLocaleString("en-US")} of ${binding.limit.toLocaleString("en-US")} ${period} emails used`
}
