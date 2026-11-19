"use client"

import * as React from "react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { AnimatedCounter } from "@repo/ui/components/animated-counter/animated-counter"
import styles from "@repo/ui/components/metric-card/metric-card.module.css"

/**
 * A page's headline numbers: Arc's MetricCard in a row of equal cards
 * (Arc's composition: `repeat(auto-fit, minmax(…, 1fr))`, 16px apart).
 */
export function KpiRow({
  children,
  loading,
}: {
  children: React.ReactNode
  loading?: boolean
}) {
  return (
    <BoneScope id="kpi" loading={loading}>
      <section
        aria-label="Key numbers"
        className="grid grid-cols-2 items-stretch gap-4 md:grid-cols-3 2xl:grid-cols-6"
      >
        {children}
      </section>
    </BoneScope>
  )
}

/** The share of `total` that `part` is, as a number for MetricCard's suffix. */
export function share(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0
}

export interface MetricCardProps {
  label: string
  value?: number
  suffix?: string
  context: string
  /** The context holds a number from the data: it is a Bone, and `context` is what it becomes. */
  derived?: boolean
  change?: string
  loading?: boolean
}

export function MetricCard({
  label,
  value,
  suffix,
  context,
  derived = false,
  change,
  loading: loadingProp,
}: MetricCardProps) {
  const loading = loadingProp ?? value === undefined
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-")

  return (
    <BoneScope id={`metric-${id}`} loading={loading}>
      <article className={styles.card}>
        <div className={styles.top}>
          <span>{label}</span>
          {change !== undefined && (
            <Bone id="change" shape="box" width={48} height={22} radius={9999} inline>
              {change && (
                <small
                  data-trend={
                    /^[+]/.test(change)
                      ? "up"
                      : /^[-−]/.test(change)
                        ? "down"
                        : undefined
                  }
                >
                  <span>{change}</span>
                </small>
              )}
            </Bone>
          )}
        </div>
        <Bone id="value" width={88} lineHeight={36}>
          {value !== undefined && (
            <AnimatedCounter value={value} suffix={suffix} animateOnView />
          )}
        </Bone>
        <p>
          {derived ? (
            <Bone id="context" width={110} lineHeight={16} inline>
              {loading ? undefined : context}
            </Bone>
          ) : (
            context
          )}
        </p>
      </article>
    </BoneScope>
  )
}
