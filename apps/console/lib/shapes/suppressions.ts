import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { SuppressionRow } from "@/lib/types"

/** What the suppressions page loads. */
export interface SuppressionsData {
  rows: SuppressionRow[]
  nextCursor: string | null
  error?: string
}

export interface SuppressionsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** Whether there is a next page behind the cursor. */
  hasMore: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const suppressionsShapeFallback: SuppressionsShape = { rows: 8, hasMore: false }

export const suppressionsShape = defineShape<SuppressionsShape, SuppressionsData>({
  page: "suppressions",
  fallback: suppressionsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.suppressions
    return n === undefined ? null : { ...suppressionsShapeFallback, rows: n }
  },
  of: ({ rows, nextCursor }) => ({
    rows: Math.min(rows.length, MAX_SKELETON_ROWS),
    hasMore: nextCursor !== null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return { rows, hasMore: r.hasMore === true }
  },
})
