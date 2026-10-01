import { cn } from "cn"
import type { Badge as BadgeKind } from "@/lib/site"

const TONE: Record<BadgeKind, string> = {
  new: "text-brand",
  beta: "text-hue-send",
  soon: "text-fg-3",
  labs: "text-hue-mail",
}

/*
 * Webflow's footer badge: tiny spaced capitals in a colour, no pill. A pill
 * next to every third footer link turns the column into a row of buttons; a
 * word in caps sits in the line like a superscript and still gets noticed.
 */
export function Badge({ kind, className }: { kind: BadgeKind; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[9.5px] leading-none font-medium tracking-[0.12em] uppercase",
        TONE[kind],
        className,
      )}
    >
      {kind}
    </span>
  )
}

/* The pill form, for places a badge stands alone (announcement bars, cards). */
export function Pill({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full bg-brand-soft px-2 font-mono text-[10px] leading-none font-medium tracking-[0.08em] text-brand uppercase",
        className,
      )}
    >
      {children}
    </span>
  )
}
