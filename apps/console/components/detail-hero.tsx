import * as React from "react"
import { cn } from "cn"

/**
 * The top of a detail page, Resend's way: an icon tile, what kind of thing
 * this is, its name, and the page's actions.
 *
 * ⚠ THE TILE TAKES THE RESOURCE'S STATE AS ITS COLOUR - a verified domain's
 * globe is green, a bounced email's envelope red - so the state is the first
 * thing seen, before a word is read. The word is still there, in the status
 * below; colour is never the only signal.
 */
export type HeroTone = "neutral" | "success" | "warning" | "danger" | "info"

const TILE: Record<HeroTone, string> = {
  neutral: "from-muted to-background text-foreground/80 ring-border",
  success:
    "from-emerald-500/25 to-emerald-500/5 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300",
  warning:
    "from-amber-500/25 to-amber-500/5 text-amber-600 ring-amber-500/30 dark:text-amber-300",
  danger: "from-red-500/25 to-red-500/5 text-red-600 ring-red-500/30 dark:text-red-300",
  info: "from-sky-500/25 to-sky-500/5 text-sky-600 ring-sky-500/30 dark:text-sky-300",
}

export function DetailHero({
  back,
  icon,
  tone = "neutral",
  eyebrow,
  title,
  subtitle,
  description,
  actions,
}: {
  back?: React.ReactNode
  icon: React.ReactNode
  tone?: HeroTone
  eyebrow?: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** A sentence under the title, at reading size - "Add domain" uses it. */
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {back}
        <div
          className={cn(
            "grid size-14 shrink-0 place-items-center rounded-2xl bg-linear-to-b shadow-sm ring-1 ring-inset",
            "animate-in fade-in-0 zoom-in-95 duration-300 [&_svg]:size-7",
            TILE[tone],
          )}
          aria-hidden
        >
          {icon}
        </div>
        <div className="min-w-0">
          {eyebrow && <p className="text-xs text-muted-foreground">{eyebrow}</p>}
          <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          )}
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * The row of facts under the hero: CREATED, STATUS, PROVIDER, REGION - small
 * capitals over the value, as Resend lays them out.
 */
export function MetaGrid({
  items,
  className,
}: {
  items: { label: string; value: React.ReactNode }[]
  className?: string
}) {
  return (
    <dl className={cn("grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4", className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {item.label}
          </dt>
          <dd className="mt-1.5 min-w-0 truncate text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
