import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { SegmentRow } from "@/lib/types"

/** What the segments page loads. `error` replaces the list, not the page. */
export interface SegmentsData {
  segments: SegmentRow[]
  error?: string
  view?: "table" | "grid"
}

export interface SegmentsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** List or grid view layout (default grid). */
  view: "table" | "grid"
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const segmentsShapeFallback: SegmentsShape = { rows: 3, view: "grid" }

export const segmentsShape = defineShape<SegmentsShape, SegmentsData>({
  page: "segments",
  fallback: segmentsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.segments
    return n === undefined ? null : { ...segmentsShapeFallback, rows: n }
  },
  of: ({ segments, view }) => ({
    rows: Math.min(segments.length, MAX_SKELETON_ROWS),
    view: view ?? "grid",
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    if (r.view !== undefined && r.view !== "grid" && r.view !== "table") return null
    return {
      rows,
      view: r.view === "table" ? "table" : "grid",
    }
  },
})
