import * as React from "react"
import { TextReveal } from "@repo/ui/components/text-reveal/text-reveal"
import { Breadcrumb } from "@repo/ui/components/breadcrumb/breadcrumb"
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

export interface Crumb {
  label: string
  href: string
}

/**
 * The head of a record page, Arc's way: a breadcrumb path back to the list
 * (Arc's Breadcrumb, which slides new crumbs in), then the record's name in
 * the display face with a plain icon beside it, and the page's actions on the
 * right. No eyebrow over the title and no icon tile: Arc's rules for both.
 *
 * `tone` is kept for callers but no longer colours anything; a record's status
 * is shown where it is labelled (the meta row's badge).
 */
export function DetailHero({
  crumbs = [],
  icon,
  eyebrow,
  title,
  subtitle,
  description,
  actions,
}: {
  crumbs?: Crumb[]
  icon?: React.ReactNode
  tone?: HeroTone
  /** The breadcrumb's last item when the title is not plain text. */
  eyebrow?: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  const current = typeof title === "string" ? title : eyebrow
  return (
    <div className="grid gap-3">
      {/* The shell's bar carries the path on wide screens (components/shell-bar). */}
      {crumbs.length > 0 && (
        <div className="lg:hidden">
          <Breadcrumb items={[...crumbs, ...(current ? [{ label: current }] : [])]} />
        </div>
      )}
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span
              className="shrink-0 text-muted-foreground [&_svg]:size-6 [&_svg]:[stroke-width:1.75]"
              aria-hidden
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            {typeof title === "string" ? (
              <TextReveal
                as="h1"
                text={title}
                className="truncate font-display text-3xl leading-[1.1] font-normal tracking-[-0.03em]"
              />
            ) : (
              <h1 className="truncate font-display text-3xl leading-[1.1] font-normal tracking-[-0.03em]">
                {title}
              </h1>
            )}
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
    </div>
  )
}

/**
 * The row of facts under the hero: created, status, provider, region. A
 * quiet label over each value.
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
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1.5 min-w-0 truncate text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
