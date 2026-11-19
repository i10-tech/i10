import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { Candidate, TeamInbox } from "@/lib/team-inbox"

/** What a team inbox's page loads. */
export interface TeamInboxDetailData {
  inbox: TeamInbox
  /** People who can be added. Admins only. */
  candidates: readonly Candidate[]
  isAdmin: boolean
}

export interface TeamInboxDetailShape {
  /** An owner or admin edits the members and may delete; a member reads them. */
  admin: boolean
  /** Member rows a member's read-only list draws, capped. */
  members: number
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const teamInboxDetailShape = defineShape<
  TeamInboxDetailShape,
  TeamInboxDetailData
>({
  page: "team-inbox-detail",
  fallback: { admin: true, members: 3 },
  of: ({ inbox, isAdmin }) => ({
    admin: isAdmin,
    members: Math.min(inbox.members.length, MAX_SKELETON_ROWS),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const members = count(r.members, MAX_SKELETON_ROWS)
    if (members === null) return null
    return { admin: r.admin === true, members }
  },
})

/** Plausible shape stashed before navigating from a team inbox row to its page. */
export function seedTeamInboxShape(
  inbox: TeamInbox,
  isAdmin: boolean,
): TeamInboxDetailShape {
  return teamInboxDetailShape.of({ inbox, candidates: [], isAdmin })
}
