import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { CreateTeamInboxProps } from "@/components/team-inboxes-view"
import type { TeamInbox } from "@/lib/team-inbox"

/** What the team inboxes page loads. `error` replaces the list, not the page. */
export interface TeamInboxesData {
  inboxes: readonly TeamInbox[]
  isAdmin: boolean
  create: CreateTeamInboxProps
  error?: string
}

export interface TeamInboxesShape {
  /** An owner or admin may create, so the header and the empty state offer it. */
  admin: boolean
  /** Rows to draw, capped; 0 is the empty state. */
  rows: number
  /** Some domain hosts mailboxes, so the empty state offers Create. */
  hosted: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const teamInboxesShape = defineShape<TeamInboxesShape, TeamInboxesData>({
  page: "team-inboxes",
  // A first visit draws the admin's list: the common case, and the one with most to draw.
  fallback: { admin: true, rows: 2, hosted: true },
  of: (data) => ({
    admin: data.isAdmin,
    rows: Math.min(data.inboxes.length, MAX_SKELETON_ROWS),
    hosted: data.create.domains.length > 0,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return { admin: r.admin === true, rows, hosted: r.hosted === true }
  },
})
