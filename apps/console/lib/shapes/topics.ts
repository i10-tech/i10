import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { TopicRow } from "@/lib/types"

/** What the topics page loads. `error` replaces the list, not the page. */
export interface TopicsData {
  topics: TopicRow[]
  error?: string
  view?: "table" | "grid"
}

export interface TopicsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** List or grid view layout. */
  view: "table" | "grid"
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const topicsShapeFallback: TopicsShape = { rows: 3, view: "table" }

export const topicsShape = defineShape<TopicsShape, TopicsData>({
  page: "topics",
  fallback: topicsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.topics
    return n === undefined ? null : { ...topicsShapeFallback, rows: n }
  },
  of: ({ topics, view }) => ({
    rows: Math.min(topics.length, MAX_SKELETON_ROWS),
    view: view ?? "table",
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    if (r.view !== undefined && r.view !== "grid" && r.view !== "table") return null
    return {
      rows,
      view: r.view === "grid" ? "grid" : "table",
    }
  },
})
