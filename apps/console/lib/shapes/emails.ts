import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { ApiKeyRow, DomainSummary, EmailRow } from "@/lib/types"

/** What the emails log page loads. */
export interface EmailsData {
  rows: EmailRow[]
  nextCursor: string | null
  domains: DomainSummary[]
  apiKeys: ApiKeyRow[]
  error?: string
}

export interface EmailsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** Whether there is a next page behind the cursor. */
  hasMore: boolean
  /** More than one domain, so the filter shows. */
  domainFilter: boolean
  /** At least one API key, so the filter shows. */
  keyFilter: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const emailsShapeFallback: EmailsShape = {
  rows: 8,
  hasMore: false,
  domainFilter: false,
  keyFilter: false,
}

export const emailsShape = defineShape<EmailsShape, EmailsData>({
  page: "emails",
  fallback: emailsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.emails
    return n === undefined
      ? null
      : {
          ...emailsShapeFallback,
          rows: n,
          domainFilter: (counts.domains ?? 0) > 1,
          keyFilter: (counts.apiKeys ?? 0) > 0,
        }
  },
  of: ({ rows, nextCursor, domains, apiKeys }) => ({
    rows: Math.min(rows.length, MAX_SKELETON_ROWS),
    hasMore: nextCursor !== null,
    domainFilter: domains.length > 1,
    keyFilter: apiKeys.length > 0,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return {
      rows,
      hasMore: r.hasMore === true,
      domainFilter: r.domainFilter === true,
      keyFilter: r.keyFilter === true,
    }
  },
})
