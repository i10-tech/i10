"use client"

import * as React from "react"
import { motion } from "motion/react"
import { cn } from "cn"

/** The back panel with its tab on the left, in a 100 x 80 box. */
const BACK =
  "M0 9a9 9 0 0 1 9-9h21.5a6 6 0 0 1 5 2.7l3.2 4.6a4 4 0 0 0 3.3 1.7H91a9 9 0 0 1 9 9V71a9 9 0 0 1-9 9H9a9 9 0 0 1-9-9z"

/**
 * A folder, drawn: a back panel with a tab, up to three sheets of paper for
 * the templates inside, and a frosted front panel - Resend's folder card.
 *
 * ⚠ THE PAPERS ARE THE COUNT. An empty folder shows none, so "Empty" under
 * it is something the picture already said; a full one shows three.
 *
 * ⚠ IT LIFTS ON HOVER AND WHEN A TEMPLATE IS DRAGGED OVER IT. The papers
 * rising out of the folder is what says "drop it here" without a word, and
 * the same motion on hover says the card opens.
 */
export function FolderArt({
  count,
  raised,
  over,
  className,
}: {
  count: number
  /** Hovered or focused: the papers peek out. */
  raised: boolean
  /** A template is being dragged over it: the papers rise all the way. */
  over: boolean
  className?: string
}) {
  const sheets = Math.min(count, 3)
  const lift = over ? -26 : raised ? -12 : 0

  const id = React.useId()

  return (
    <div className={cn("relative aspect-[5/4] w-[60%] [perspective:800px]", className)}>
      {/* Back panel and its tab, as ONE shape: two overlapping boxes leave a
          seam and a darker strip where they cross. */}
      <svg
        aria-hidden
        viewBox="0 0 100 80"
        className="absolute inset-0 size-full overflow-visible text-foreground"
      >
        <defs>
          <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.07" />
          </linearGradient>
        </defs>
        <path d={BACK} fill={`url(#${id}-back)`} />
        <path
          d={BACK}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.08"
          strokeWidth="0.6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* The templates inside. */}
      {Array.from({ length: sheets }, (_, i) => (
        <motion.div
          key={i}
          aria-hidden
          initial={false}
          animate={{
            y: lift * (1 - i * 0.22),
            rotate: (i - (sheets - 1) / 2) * (over ? 4 : raised ? 2.5 : 0),
          }}
          transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
          className="absolute h-[46%] rounded-[6px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_rgb(0_0_0/0.05)] dark:bg-neutral-200"
          style={{
            zIndex: 1 + i,
            left: `${14 + i * 3}%`,
            right: `${14 - i * 3}%`,
            top: `${17 + i * 4}%`,
          }}
        >
          <div className="mx-[12%] mt-[14%] space-y-[6%]">
            <div className="h-1 w-1/2 rounded-full bg-neutral-200" />
            <div className="h-1 w-5/6 rounded-full bg-neutral-100" />
            <div className="h-1 w-2/3 rounded-full bg-neutral-100" />
          </div>
        </motion.div>
      ))}

      {/* Front panel: frosted, tilting back as the papers rise. */}
      <motion.div
        aria-hidden
        initial={false}
        animate={{ rotateX: over ? -16 : raised ? -8 : 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 28 }}
        style={{ transformOrigin: "50% 100%", zIndex: 10 }}
        className={cn(
          "absolute inset-x-0 top-[32%] bottom-0 overflow-hidden rounded-[12%/15%] backdrop-blur-[6px]",
          "bg-gradient-to-b from-neutral-200/85 to-neutral-300/95 ring-1 ring-black/[0.06] ring-inset",
          "dark:from-neutral-600/75 dark:to-neutral-800/95 dark:ring-white/[0.08]",
          "shadow-[0_-1px_0_rgb(255_255_255/0.5)_inset] dark:shadow-[0_1px_0_rgb(255_255_255/0.08)_inset]",
        )}
      >
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgb(255_255_255/0.45),transparent_60%)] dark:bg-[radial-gradient(120%_80%_at_50%_0%,rgb(255_255_255/0.12),transparent_60%)]" />
      </motion.div>
    </div>
  )
}

/**
 * The folder at icon size, for breadcrumbs and menus: the same tab and
 * two-tone panels, without the papers or the motion.
 */
export function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 16"
      className={cn("size-4 text-foreground", className)}
    >
      <path
        d="M1 3.2A2.2 2.2 0 0 1 3.2 1h4.1a1.6 1.6 0 0 1 1.3.7l.8 1.1a1 1 0 0 0 .8.4h6.6A2.2 2.2 0 0 1 19 5.4v8.4a2.2 2.2 0 0 1-2.2 2.2H3.2A2.2 2.2 0 0 1 1 13.8z"
        fill="currentColor"
        fillOpacity="0.28"
      />
      <rect
        x="1"
        y="6"
        width="18"
        height="10"
        rx="2.2"
        fill="currentColor"
        fillOpacity="0.55"
      />
    </svg>
  )
}
