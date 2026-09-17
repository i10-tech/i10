import * as React from "react"
import { cn } from "cn"

/*
 * Usage against an allowance.
 *
 * ⚠ THIS IS A BILLING CONTROL BEFORE IT IS A PROGRESS BAR, AND THE DIFFERENCE
 * IS WHAT HAPPENS PAST 100%. A progress bar cannot exceed its track; a meter
 * can, because a tenant with overage enabled is SUPPOSED to be able to send
 * past their included volume and be billed for it. Clamping the fill and
 * calling it done would show a customer a full bar at 40,000 sends and the same
 * full bar at 400,000, which is the one number they opened the page for.
 *
 * ⚠ AND THE TONE IS DERIVED, NOT PASSED. Whether being at 90% is a warning
 * depends on whether the plan bills past the line — on overage it is a
 * forecast, and on a hard cap it is a deadline. One rule, here, rather than
 * every caller deciding.
 */

export interface MeterProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Units consumed this period. */
  used: number
  /**
   * Units included. `null` means unlimited — the bar is then not drawn at all,
   * because a bar with no end is a lie about there being one.
   */
  limit: number | null
  /** Whether the plan bills past `limit` rather than refusing. */
  overage?: boolean
}

export function Meter({
  used,
  limit,
  overage = false,
  className,
  ...props
}: MeterProps) {
  if (limit === null || limit <= 0) {
    return (
      <div
        data-slot="meter"
        className={cn("h-1.5 w-full rounded-full bg-muted", className)}
        {...props}
      />
    )
  }

  const ratio = used / limit
  const over = ratio > 1

  /*
   * ⚠ THE OVERAGE SEGMENT IS DRAWN INSIDE THE SAME TRACK, NOT PAST IT. The
   * track stays the width of the allowance — that is what it means — and the
   * portion of it painted in the overage tone is `1 - 1/ratio`, i.e. how much
   * of what you have sent is past the line. At 2× the bar is half included and
   * half billable, which is true and immediately readable. Letting the fill
   * overflow its parent would break every layout it sits in.
   */
  const includedPct = over ? (1 / ratio) * 100 : ratio * 100
  const overPct = over ? 100 - includedPct : 0

  const tone = over
    ? overage
      ? "bg-info"
      : "bg-danger"
    : ratio >= 0.9
      ? overage
        ? "bg-foreground"
        : "bg-warning"
      : "bg-foreground"

  return (
    <div
      data-slot="meter"
      role="meter"
      aria-valuenow={used}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuetext={`${used.toLocaleString()} of ${limit.toLocaleString()}`}
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      {...props}
    >
      <div
        className={cn("h-full transition-[width]", tone)}
        style={{
          width: `${includedPct}%`,
          transitionDuration: "var(--duration-move)",
          transitionTimingFunction: "var(--ease-quint-out)",
        }}
      />
      {overPct > 0 && (
        <div
          className={cn("h-full", overage ? "bg-info" : "bg-danger")}
          style={{ width: `${overPct}%` }}
        />
      )}
    </div>
  )
}

/**
 * The meter with its numbers — what actually goes on a usage page.
 *
 * ⚠ THE COUNTS ARE `tabular`. A column of usage rows whose digits are
 * proportionally spaced is ragged down its right edge, and the eye reads the
 * ragged edge as the data being unreliable.
 */
export function MeterRow({
  label,
  used,
  limit,
  unit,
  overage = false,
  format = (n: number) => n.toLocaleString(),
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  used: number
  limit: number | null
  unit?: string
  overage?: boolean
  format?: (n: number) => string
}) {
  const over = limit !== null && limit > 0 && used > limit

  return (
    <div data-slot="meter-row" className={cn("space-y-2", className)} {...props}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="tabular text-sm text-muted-foreground">
          <span className={cn("text-foreground", over && !overage && "text-danger")}>
            {format(used)}
          </span>
          {limit === null ? (
            <span className="text-muted-foreground"> used</span>
          ) : (
            <>
              {" / "}
              {format(limit)}
              {unit ? ` ${unit}` : ""}
            </>
          )}
        </span>
      </div>
      <Meter used={used} limit={limit} overage={overage} />
      {over && (
        <p className={cn("text-xs", overage ? "text-muted-foreground" : "text-danger")}>
          {overage
            ? `${format(used - (limit ?? 0))} over your included volume, billed as overage.`
            : `${format(used - (limit ?? 0))} over your plan's limit.`}
        </p>
      )}
    </div>
  )
}
