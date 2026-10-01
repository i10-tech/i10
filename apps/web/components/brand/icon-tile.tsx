import type { CSSProperties } from "react"
import { cn } from "cn"
import type { Hue, IconName } from "@/lib/site"
import { PixelIcon } from "./pixel-icon"

/*
 * A pixel icon on a tinted tile. The hue tints the tile at rest and lights up
 * on hover of the nearest `.group`; without a hue the tile stays neutral and
 * the icon takes the foreground colour.
 */
export function IconTile({
  icon,
  hue,
  size = "md",
  className,
}: {
  icon: IconName
  hue?: Hue
  size?: "sm" | "md" | "lg"
  className?: string
}) {
  const color = hue ? `var(--hue-${hue})` : "var(--fg-2)"
  const box =
    size === "sm"
      ? "size-7 rounded-[8px]"
      : size === "lg"
        ? "size-12 rounded-[14px]"
        : "size-9 rounded-[10px]"
  const px = size === "sm" ? 14 : size === "lg" ? 22 : 16

  return (
    <span
      className={cn(
        "icon-tile relative inline-flex shrink-0 items-center justify-center",
        box,
        className,
      )}
      style={{ "--tile": color, color } as CSSProperties}
    >
      <PixelIcon name={icon} size={px} />
    </span>
  )
}
