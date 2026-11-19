import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { ApiKeyRow, DomainSummary } from "@/lib/types"

/** What the API keys page loads. */
export interface ApiKeysData {
  keys: ApiKeyRow[]
  domains: DomainSummary[]
  error?: string
  newKey?: boolean
}

export interface ApiKeysShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const apiKeysShapeFallback: ApiKeysShape = { rows: 5 }

export const apiKeysShape = defineShape<ApiKeysShape, ApiKeysData>({
  page: "api-keys",
  fallback: apiKeysShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.apiKeys
    return n === undefined ? null : { ...apiKeysShapeFallback, rows: n }
  },
  of: ({ keys }) => ({
    rows: Math.min(keys.length, MAX_SKELETON_ROWS),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return { rows }
  },
})
