import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { TeamCapacity } from "@/lib/actions"
import type { EmailRow, Overview, SendingHealth, SendingStatus } from "@/lib/types"

/** What the overview page loads across its panels. */
export interface OverviewData {
  overview?: Overview
  overviewError?: string
  recent?: EmailRow[]
  recentError?: string
  sendingStatus?: SendingStatus | null
  capacity?: TeamCapacity | null
  sendingHealth?: SendingHealth
  sendingHealthError?: string
  suggestions?: boolean
  days: number
}

export type OverviewBanner = "none" | "status" | "capacity" | "both"

export interface OverviewShape {
  /** Recent sends row count, capped; 0 draws empty state. */
  recent: number
  /** Which advisory banners are active so their height is reserved. */
  banner: OverviewBanner
  /** Workspace suggestions card for Clerk users. */
  suggestions: boolean
  /** Range in days from the URL parameter. */
  days: number
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const ALLOWED_DAYS = [7, 14, 30, 90] as const

/** Whether the sending status draws the overview's banner. */
export const atRisk = (status: SendingStatus | null | undefined) =>
  Boolean(status && (status.status !== "enabled" || status.health !== "healthy"))

/** The overview's recent-sends list asks for this many (app/(app)/(home)/page.tsx). */
const RECENT_LIMIT = 8

const overviewFallback: OverviewShape = {
  recent: 6,
  banner: "none",
  suggestions: false,
  days: 30,
}

export const overviewShape = defineShape<OverviewShape, OverviewData>({
  page: "overview",
  fallback: overviewFallback,
  // A first visit: the recent list from the emails count, the banner from the
  // sending status the layout reads (`sendingAtRisk`). Capacity is not known.
  fromCounts: (counts) =>
    counts.emails === undefined && counts.sendingAtRisk === undefined
      ? null
      : {
          ...overviewFallback,
          recent:
            counts.emails === undefined
              ? overviewFallback.recent
              : Math.min(counts.emails, RECENT_LIMIT),
          banner: counts.sendingAtRisk === 1 ? "status" : "none",
        },
  of: (data) => {
    const hasStatus = atRisk(data.sendingStatus)
    const hasCapacity = Boolean(
      data.capacity?.alert &&
      data.capacity.alert.level !== 0 &&
      !data.capacity.personal &&
      data.capacity.members * 100 >= data.capacity.limit * 80,
    )
    const banner: OverviewBanner =
      hasStatus && hasCapacity
        ? "both"
        : hasStatus
          ? "status"
          : hasCapacity
            ? "capacity"
            : "none"
    const recentCount = data.recent
      ? Math.min(data.recent.length, MAX_SKELETON_ROWS)
      : 0
    const days = ALLOWED_DAYS.includes(data.days as (typeof ALLOWED_DAYS)[number])
      ? data.days
      : 30
    return {
      recent: recentCount,
      banner,
      suggestions: Boolean(data.suggestions),
      days,
    }
  },
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const recent = count(r.recent, MAX_SKELETON_ROWS)
    if (recent === null) return null
    const banner: OverviewBanner =
      r.banner === "status" || r.banner === "capacity" || r.banner === "both"
        ? r.banner
        : "none"
    const days = ALLOWED_DAYS.includes(Number(r.days) as (typeof ALLOWED_DAYS)[number])
      ? Number(r.days)
      : 30
    return {
      recent,
      banner,
      suggestions: r.suggestions === true,
      days,
    }
  },
})
