import type { ComponentProps } from "react"
import { cn } from "cn"

/**
 * A fixed-shape placeholder: an avatar square, a workspace row, a control.
 *
 * Arc's Skeleton draws lines of text (and an avatar), which is what most
 * loading states are; this covers the few placeholders that hold the place of
 * one known shape instead. Same material as Arc's: the muted surface, a slow
 * pulse, still under reduced motion.
 */
export function SkeletonBlock({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-lg bg-[var(--surface-muted)] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  )
}
