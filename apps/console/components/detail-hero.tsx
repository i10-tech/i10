"use client"

import * as React from "react"
import { Bone, BoneScope, useBoneLoading } from "@repo/ui/components/bone/bone"
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

export type DetailHeroProps = {
  crumbs?: Crumb[]
  icon?: React.ReactNode
  tone?: HeroTone
  /** The breadcrumb's last item when the title is not plain text. */
  eyebrow?: string
  title?: React.ReactNode
  subtitle?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  status?: React.ReactNode
  loading?: boolean
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
  status,
  loading: loadingProp,
}: {
  crumbs?: Crumb[]
  icon?: React.ReactNode
  tone?: HeroTone
  /** The breadcrumb's last item when the title is not plain text. */
  eyebrow?: string
  title?: React.ReactNode
  subtitle?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  status?: React.ReactNode
  loading?: boolean
}) {
  const current = typeof title === "string" ? title : eyebrow
  return (
    <BoneScope id="hero" loading={loadingProp}>
      <div className="grid gap-3">
        {/* The shell's bar carries the path on wide screens (components/shell-bar). */}
        {crumbs.length > 0 && (
          <div className="lg:hidden">
            <HeroCrumbs crumbs={crumbs} current={current} />
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
              <Bone
                id="title"
                as="div"
                lineHeight={34}
                width={260}
                className="max-w-full"
              >
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
              </Bone>
              {subtitle !== undefined && subtitle !== null && (
                <Bone
                  id="subtitle"
                  as="div"
                  lineHeight={16}
                  width={180}
                  className="mt-1 max-w-full"
                >
                  <p className="truncate text-xs text-muted-foreground">
                    {typeof subtitle === "boolean" ? null : subtitle}
                  </p>
                </Bone>
              )}
              {description !== undefined && description !== null && (
                <Bone
                  id="description"
                  as="div"
                  lineHeight={20}
                  width={280}
                  className="mt-0.5 max-w-full"
                >
                  <p className="text-sm text-muted-foreground">
                    {typeof description === "boolean" ? null : description}
                  </p>
                </Bone>
              )}
            </div>
          </div>
          {(actions || status) && (
            <div className="flex shrink-0 items-center gap-2">
              {status && (
                <Bone
                  id="status"
                  shape="box"
                  width={76}
                  height={20}
                  radius={9999}
                  inline
                >
                  {status}
                </Bone>
              )}
              {actions}
            </div>
          )}
        </div>
      </div>
    </BoneScope>
  )
}

/**
 * The path back to the list, ending in the record's own name.
 *
 * ⚠ THE LAST CRUMB NAMES DATA, SO IT IS A BONE: a bar while the record loads, the
 * title once it has. Left out of the path while loading, it popped in.
 */
function HeroCrumbs({ crumbs, current }: { crumbs: Crumb[]; current?: string }) {
  const loading = useBoneLoading()
  const last = current !== undefined || loading
  return (
    <Breadcrumb
      items={[...crumbs, ...(last ? [{ label: current ?? "", loading }] : [])]}
    />
  )
}

export interface MetaItem {
  label: string
  value?: React.ReactNode
  shape?: "text" | "box" | "circle"
  width?: number | string
  height?: number
  radius?: number | string
}

/**
 * The row of facts under the hero: created, status, provider, region. A
 * quiet label over each value.
 */
export function MetaGrid({
  items,
  className,
  loading: loadingProp,
}: {
  items: {
    label: string
    value?: React.ReactNode
    shape?: "text" | "box" | "circle"
    width?: number | string
    height?: number
    radius?: number | string
  }[]
  className?: string
  loading?: boolean
}) {
  return (
    <BoneScope id="meta" loading={loadingProp}>
      <dl className={cn("grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4", className)}>
        {items.map((item, i) => {
          const isStatus = item.shape === "box" || item.label.toLowerCase() === "status"
          const key = item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || String(i)
          return (
            <div key={item.label || i} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="mt-1.5 min-w-0 truncate text-sm">
                <Bone
                  id={`fact-${key}`}
                  shape={isStatus ? "box" : (item.shape ?? "text")}
                  lineHeight={20}
                  width={item.width ?? (isStatus ? 76 : 110)}
                  height={isStatus ? (item.height ?? 20) : item.height}
                  radius={isStatus ? (item.radius ?? 9999) : item.radius}
                  inline={isStatus}
                >
                  {item.value}
                </Bone>
              </dd>
            </div>
          )
        })}
      </dl>
    </BoneScope>
  )
}
