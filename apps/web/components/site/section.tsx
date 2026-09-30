import type { ReactNode } from "react"
import { cn } from "cn"
import { SplitReveal } from "@/components/motion/split-reveal"

/*
 * The page's blueprint: every framed section draws a hairline across its top
 * and two rails at the container's edges, with a small cross where they meet
 * (Stytch's notches, Offbrand's crosshairs). The rails line up from section to
 * section, so the page reads as one drawing rather than a stack of blocks.
 */
export function Frame({
  children,
  className,
  inner,
  id,
  tone,
  rails = true,
  seam = true,
}: {
  children: ReactNode
  className?: string
  inner?: string
  id?: string
  tone?: "dark" | "brand" | "light"
  rails?: boolean
  seam?: boolean
}) {
  return (
    <section id={id} data-nav-tone={tone ?? "dark"} className={cn("relative", className)}>
      {seam ? <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-line" /> : null}
      {/* ⚠ THE RAILS SPAN THE SECTION, NOT THE CONTENT. The section carries the
          vertical padding, so rails drawn inside the content box stop short of
          the seam and the crosses float a padding's height below it. */}
      {rails ? (
        <div aria-hidden className="container-site pointer-events-none absolute inset-y-0 inset-x-0 max-md:hidden">
          <div className="absolute inset-y-0 left-[var(--gutter)] w-px bg-line-faint" />
          <div className="absolute inset-y-0 right-[var(--gutter)] w-px bg-line-faint" />
          {seam ? (
            <>
              <Cross className="absolute top-0 left-[var(--gutter)] -translate-x-1/2 -translate-y-1/2" />
              <Cross className="absolute top-0 right-[var(--gutter)] translate-x-1/2 -translate-y-1/2" />
            </>
          ) : null}
        </div>
      ) : null}
      <div className={cn("container-site relative", inner)}>{children}</div>
    </section>
  )
}

export function Cross({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 11 11" width="11" height="11" className={cn("pointer-events-none text-fg-4 max-md:hidden", className)}>
      <path d="M5.5 0v11M0 5.5h11" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function Eyebrow({ children, className, color = "var(--brand)" }: { children: ReactNode; className?: string; color?: string }) {
  return (
    <span className={cn("type-label inline-flex items-center gap-2 text-fg-3", className)}>
      <span aria-hidden className="size-[5px]" style={{ background: color }} />
      {children}
    </span>
  )
}

/*
 * Polar's two-tone headline: the claim in full white, its consequence in the
 * muted ramp, one heading. Reads as one sentence, scans as two.
 */
export function SectionHeader({
  eyebrow,
  title,
  muted,
  description,
  align = "left",
  size = "m",
  className,
  children,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  muted?: ReactNode
  description?: ReactNode
  align?: "left" | "center"
  size?: "l" | "m" | "s"
  className?: string
  children?: ReactNode
}) {
  const type = size === "l" ? "type-display-l" : size === "s" ? "type-display-s" : "type-display-m"
  return (
    <div className={cn("flex flex-col gap-5", align === "center" && "items-center text-center", className)}>
      {eyebrow ? <div data-reveal>{eyebrow}</div> : null}
      <SplitReveal as="h2" className={cn(type, align === "center" ? "max-w-[22ch]" : "max-w-[20ch]")}>
        {title}
        {muted ? <span className="text-fg-3"> {muted}</span> : null}
      </SplitReveal>
      {description ? (
        <p data-reveal className={cn("type-lead max-w-[36rem]", align === "center" && "mx-auto")}>
          {description}
        </p>
      ) : null}
      {children}
    </div>
  )
}
