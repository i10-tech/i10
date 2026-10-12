import type { ReactNode } from "react"
import { MetricCard } from "@repo/ui/components/metric-card/metric-card"

/**
 * A page's headline numbers: Arc's MetricCard in a row of equal cards
 * (Arc's composition: `repeat(auto-fit, minmax(…, 1fr))`, 16px apart).
 */
export function KpiRow({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Key numbers"
      className="grid grid-cols-2 items-stretch gap-4 md:grid-cols-3 2xl:grid-cols-6"
    >
      {children}
    </section>
  )
}

/** The share of `total` that `part` is, as a number for MetricCard's suffix. */
export function share(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0
}

export { MetricCard }
