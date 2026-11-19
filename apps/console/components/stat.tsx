"use client"

import * as React from "react"
import Link from "next/link"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { cn } from "cn"
import { formatNumber } from "@/lib/format"

export type StatProps = {
  label: string
  value?: number | string
  sub?: React.ReactNode
  href?: string
  /** Colours the VALUE only, and only where the number means something bad. */
  tone?: "danger" | "warning" | "success"
  className?: string
  loading?: boolean
}

/**
 * One number, with what it means under it.
 *
 * ⚠ THE NUMBER IS `tabular` AND THE LABEL IS NOT. A row of stat tiles whose
 * digits are proportionally spaced has its values sitting at slightly different
 * optical positions, which reads as the layout being sloppy rather than the
 * font being default. Prose in tabular figures looks mechanical, so the label
 * stays proportional.
 *
 * ⚠ AND THERE IS NO BORDER BETWEEN TILES BY DEFAULT. On a true-black canvas a
 * grid of bordered boxes is a lot of line for very little content; the tiles
 * sit in one bordered container and are separated by its internal dividers,
 * which is one line instead of four per tile.
 */
export function Stat({
  label,
  value,
  sub,
  href,
  tone,
  className,
  loading: loadingProp,
}: {
  label: string
  value?: number | string
  sub?: React.ReactNode
  href?: string
  /** Colours the VALUE only, and only where the number means something bad. */
  tone?: "danger" | "warning" | "success"
  className?: string
  loading?: boolean
}) {
  const loading = loadingProp ?? value === undefined
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-")

  const body = (
    <BoneScope id={`stat-${id}`} loading={loading}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {/* ⚠ THE BONE CARRIES THE VALUE'S `mt-1` WHILE LOADING: loaded, that margin is the <p>'s inside the bone, and a tile 4px shorter drew every tile under it 4px high. */}
      <Bone
        id="value"
        width={80}
        lineHeight={32}
        inline
        className={loading ? "mt-1" : undefined}
      >
        {value !== undefined && (
          <p
            className={cn(
              "tabular mt-1 font-display text-2xl font-medium tracking-tight",
              tone === "danger" && "text-danger",
              tone === "warning" && "text-warning",
              tone === "success" && "text-success",
            )}
          >
            {typeof value === "number" ? formatNumber(value) : value}
          </p>
        )}
      </Bone>
      {sub !== undefined && (
        <Bone
          id="sub"
          width={64}
          lineHeight={16}
          className={loading ? "mt-0.5" : undefined}
        >
          <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
        </Bone>
      )}
    </BoneScope>
  )

  if (href) {
    const classes = cn(
      "block px-4 py-3.5 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/40",
      className,
    )
    // ⚠ THE SKELETON'S TILE IS THE LINK'S TILE, with nowhere to go yet.
    return loading ? (
      <a aria-hidden tabIndex={-1} className={classes}>
        {body}
      </a>
    ) : (
      <Link href={href} className={classes}>
        {body}
      </Link>
    )
  }

  return <div className={cn("px-4 py-3.5", className)}>{body}</div>
}

/**
 * ⚠ THE DIVIDERS ARE `divide-x` PLUS A WRAP-AWARE `divide-y`, because this grid
 * REFLOWS. At three columns the fourth tile wraps to a second row, and a plain
 * `divide-x` leaves it with a hanging vertical rule and no horizontal one. The
 * border on the container plus dividers on both axes is correct at every
 * breakpoint without a media query per layout.
 */
export function StatRow({
  children,
  loading,
}: {
  children: React.ReactNode
  loading?: boolean
}) {
  return (
    /*
     * ⚠ THE ONLY CLIENT COMPONENT ON THIS SCREEN, AND IT WRAPS THE STRIP RATHER
     * THAN THE TILES. `Stat` stays a server component - six of them tracking
     * their own pointer would be six listeners, six bundles and six gradients
     * that stop at their own edges, so the wash would visibly break at every
     * divider. See @repo/ui/components/pointer-glow: it sets two CSS variables
     * and never calls setState, so following the cursor costs no React renders.
     */
    <BoneScope id="stat-row" loading={loading}>
      <div className="overflow-hidden rounded-2xl border bg-card">
        <div className="grid grid-cols-2 divide-x divide-y md:grid-cols-3 lg:grid-cols-6">
          {children}
        </div>
      </div>
    </BoneScope>
  )
}
