import type { ReactNode } from "react"
import { cn } from "cn"
import { SplitReveal } from "@/components/motion/split-reveal"
import { Eyebrow } from "@/components/site/section"

/*
 * The top of every secondary page: an eyebrow, a headline that scatters in
 * the way the home hero does, a lede, and an optional right-hand slot. The
 * grid behind it is the home hero's, so a secondary page still reads as part
 * of the same drawing.
 */
export function PageHero({
  eyebrow,
  title,
  lede,
  color,
  aside,
  children,
  className,
}: {
  eyebrow: ReactNode
  title: ReactNode
  lede: ReactNode
  color?: string
  aside?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section data-nav-tone="dark" className={cn("relative overflow-hidden pt-[calc(var(--nav-h)+4.5rem)] pb-20 md:pb-24", className)}>
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />
      <div className={cn("container-site relative grid items-center gap-12", aside && "lg:grid-cols-[1.1fr_0.9fr] lg:gap-16")}>
        <div className="flex flex-col items-start">
          <div data-reveal>
            <Eyebrow color={color}>{eyebrow}</Eyebrow>
          </div>
          <SplitReveal as="h1" mode="scatter" onScroll={false} className="type-display-l mt-6 max-w-[16ch]">
            {title}
          </SplitReveal>
          <p data-reveal data-reveal-delay="0.15" className="type-lead mt-6 max-w-[34rem]">
            {lede}
          </p>
          {children}
        </div>
        {aside ? (
          <div data-reveal data-reveal-delay="0.2">
            {aside}
          </div>
        ) : null}
      </div>
    </section>
  )
}
