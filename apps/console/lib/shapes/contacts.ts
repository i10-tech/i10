import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { ContactRow, SegmentRow } from "@/lib/types"

/** What the contacts page loads. */
export interface ContactsData {
  contacts: ContactRow[]
  nextCursor: string | null
  segments: SegmentRow[]
  error?: string
}

export interface ContactsShape {
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** Number of segments, capped; >0 enables the segment filter. */
  segments: number
  /** Whether there is a next page behind the cursor. */
  hasMore: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const contactsShapeFallback: ContactsShape = { rows: 8, segments: 0, hasMore: false }

export const contactsShape = defineShape<ContactsShape, ContactsData>({
  page: "contacts",
  fallback: contactsShapeFallback,
  // A first visit's count (GET /console/shapes); what a count cannot know
  // keeps the default.
  fromCounts: (counts) => {
    const n = counts.contacts
    return n === undefined
      ? null
      : { ...contactsShapeFallback, rows: n, segments: counts.segments ?? 0 }
  },
  of: ({ contacts, segments, nextCursor }) => ({
    rows: Math.min(contacts.length, MAX_SKELETON_ROWS),
    segments: Math.min(segments.length, MAX_SKELETON_ROWS),
    hasMore: nextCursor !== null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    const segments = count(r.segments, MAX_SKELETON_ROWS)
    if (rows === null || segments === null) return null
    return { rows, segments, hasMore: r.hasMore === true }
  },
})
