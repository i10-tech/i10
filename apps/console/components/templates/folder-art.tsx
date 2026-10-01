"use client"

import { motion } from "motion/react"
import { cn } from "cn"

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

  return (
    <div className={cn("relative aspect-[5/4] w-[64%] [perspective:800px]", className)}>
      {/* Back panel, with its tab. */}
      <div className="absolute inset-x-0 top-[6%] bottom-0 rounded-[14px] bg-gradient-to-b from-foreground/[0.13] to-foreground/[0.06] ring-1 ring-foreground/[0.06] ring-inset" />
      <div className="absolute top-0 left-0 h-[14%] w-[40%] rounded-t-[12px] bg-foreground/[0.13] [clip-path:polygon(0_0,82%_0,100%_100%,0_100%)]" />

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
          className="absolute inset-x-[14%] top-[14%] h-[46%] rounded-[6px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_rgb(0_0_0/0.05)]"
          style={{
            zIndex: 1 + i,
            left: `${14 + i * 3}%`,
            right: `${14 - i * 3}%`,
            top: `${14 + i * 4}%`,
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
          "absolute inset-x-0 top-[30%] bottom-0 overflow-hidden rounded-[14px] backdrop-blur-md",
          "bg-gradient-to-b from-neutral-200/80 to-neutral-300/90 ring-1 ring-black/[0.06] ring-inset",
          "dark:from-neutral-700/70 dark:to-neutral-800/90 dark:ring-white/[0.07]",
          "shadow-[0_-1px_0_rgb(255_255_255/0.5)_inset] dark:shadow-[0_1px_0_rgb(255_255_255/0.08)_inset]",
        )}
      >
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgb(255_255_255/0.45),transparent_60%)] dark:bg-[radial-gradient(120%_80%_at_50%_0%,rgb(255_255_255/0.12),transparent_60%)]" />
      </motion.div>
    </div>
  )
}
