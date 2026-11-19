import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { BroadcastSummary } from "@/lib/types"

/** What the broadcasts page loads. `error` replaces the list, not the page. */
export interface BroadcastsData {
  broadcasts: BroadcastSummary[]
  error?: string
  view?: "table" | "grid"
}

export interface BroadcastsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** List or grid view layout. */
  view: "table" | "grid"
  /** More than one status among the broadcasts, so the filter shows. */
  statusFilter: boolean
  /** More than one segment among the broadcasts, so the filter shows. */
  segmentFilter: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const broadcastsShapeFallback: BroadcastsShape = {
  rows: 3,
  view: "table",
  statusFilter: false,
  segmentFilter: false,
}

export const broadcastsShape = defineShape<BroadcastsShape, BroadcastsData>({
  page: "broadcasts",
  fallback: broadcastsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.broadcasts
    return n === undefined
      ? null
      : {
          ...broadcastsShapeFallback,
          rows: n,
          statusFilter: (counts.broadcastStatuses ?? 0) > 1,
        }
  },
  of: ({ broadcasts, view }) => ({
    rows: Math.min(broadcasts.length, MAX_SKELETON_ROWS),
    view: view ?? "table",
    statusFilter: new Set(broadcasts.map((b) => b.status)).size > 1,
    segmentFilter:
      new Set(broadcasts.filter((b) => b.segment_id).map((b) => b.segment_id)).size > 1,
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
      statusFilter: r.statusFilter === true,
      segmentFilter: r.segmentFilter === true,
    }
  },
})
