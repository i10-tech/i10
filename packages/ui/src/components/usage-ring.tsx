import * as React from "react"
import { cn } from "cn"

/*
 * Usage as a small ring, like the one in Claude's chat: how full the limit
 * that binds first is, at a glance, in the space of an icon.
 *
 * ⚠ THE TONE IS DERIVED HERE, NOT PASSED, for the reason the meter gives: at
 * 90% a hard cap is a deadline and overage is a forecast, and one rule in one
 * place is what keeps the ring, the popover and the usage page agreeing.
 *
 * ⚠ ONE DIFFERENCE FROM THE BAR, ON PURPOSE: a hard cap turns red AT 100%, not
 * past it. The bar can show how far over a limit somebody is; the ring's only
 * job is to say "you cannot send", which is already true at exactly 100.
 */

export type UsageTone = "neutral" | "warning" | "danger" | "info"

export function usageTone({
  used,
  limit,
  overage = false,
}: {
  used: number
  limit: number | null
  overage?: boolean
}): UsageTone {
  if (limit === null || limit <= 0) return "neutral"
  const ratio = used / limit
  if (overage) return ratio > 1 ? "info" : "neutral"
  if (ratio >= 1) return "danger"
  if (ratio >= 0.9) return "warning"
  return "neutral"
}

const STROKE: Record<UsageTone, string> = {
  neutral: "stroke-foreground",
  warning: "stroke-warning",
  danger: "stroke-danger",
  info: "stroke-info",
}

export interface UsageRingProps extends Omit<React.ComponentProps<"svg">, "children"> {
  used: number
  /** `null` is unlimited: an empty track, because a full ring would be a lie. */
  limit: number | null
  overage?: boolean
  /** Rendered size in px. */
  size?: number
}

export function UsageRing({
  used,
  limit,
  overage = false,
  size = 18,
  className,
  ...props
}: UsageRingProps) {
  const stroke = 2.5
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const ratio = limit && limit > 0 ? Math.min(used / limit, 1) : 0
  const tone = usageTone({ used, limit, overage })

  return (
    <svg
      data-slot="usage-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className={cn("shrink-0 -rotate-90", className)}
      {...props}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-muted"
      />
      {ratio > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          className={cn("transition-[stroke-dashoffset]", STROKE[tone])}
          style={{
            transitionDuration: "var(--duration-move)",
            transitionTimingFunction: "var(--ease-quint-out)",
          }}
        />
      )}
    </svg>
  )
}
