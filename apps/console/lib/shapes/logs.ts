import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { RequestRow } from "@/lib/types"

/** What the API logs page loads. */
export interface LogsData {
  rows: RequestRow[]
  nextCursor: string | null
  apiKeys: { id: string; name: string }[]
  error?: string
}

export interface LogsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** Number of API keys, capped; >0 enables the API key filter. */
  keys: number
  /** Whether there is a next page behind the cursor. */
  hasMore: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const logsShapeFallback: LogsShape = { rows: 8, keys: 0, hasMore: false }

export const logsShape = defineShape<LogsShape, LogsData>({
  page: "logs",
  fallback: logsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.logs
    return n === undefined
      ? null
      : { ...logsShapeFallback, rows: n, keys: counts.apiKeys ?? 0 }
  },
  of: ({ rows, apiKeys, nextCursor }) => ({
    rows: Math.min(rows.length, MAX_SKELETON_ROWS),
    keys: Math.min(apiKeys.length, MAX_SKELETON_ROWS),
    hasMore: nextCursor !== null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    const keys = count(r.keys, MAX_SKELETON_ROWS)
    if (rows === null || keys === null) return null
    return { rows, keys, hasMore: r.hasMore === true }
  },
})
