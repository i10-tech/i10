import { defineShape } from "@/lib/shapes"

/**
 * The team page's data is Clerk's and ours, read in the browser, so the server
 * has none of it: the page hands its view only whether Clerk is on.
 */
export interface TeamData {
  clerkEnabled: boolean
}

/**
 * What the loaded team page looked like, per workspace: every number that
 * decides the height of a section, so its skeleton can sit where the page
 * will end up. Written by the loaded panel (components/team-panel.tsx).
 */
export interface TeamShape {
  /** Member rows, capped. */
  members: number
  /** Whether the reader sees invitations, requests and the removed list. */
  canManage: boolean
  /** Whether the seats line shows above the invitations. */
  capacity: boolean
  /** Whether the Invite button shows (a personal workspace has none). */
  invitable: boolean
  invites: number
  requests: number
  /** Of those requests, the ones waiting for room (taller rows). */
  waiting: number
  /** Whether the workspace is full, which adds a line above the requests. */
  full: boolean
  /** Whether the reader may manage access domains, which shows that block. */
  accessDomains: boolean
  /** Domains with their rules, one row each. */
  domains: number
  /** Domains still waiting for a TXT proof: each opens a taller row. */
  proofs: number
  /** Verified sending domains offered for access, one card each. */
  suggestions: number
  removed: number
}

export const MAX_TEAM_MEMBERS = 25
export const MAX_TEAM_ROWS = 10

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

// A first visit: the reader and one more, seen as a manager sees it. Lists
// with nothing remembered draw one neutral line, never an empty message.
const FALLBACK: TeamShape = {
  members: 2,
  canManage: true,
  capacity: true,
  invitable: true,
  invites: 0,
  requests: 0,
  waiting: 0,
  full: false,
  accessDomains: true,
  domains: 0,
  proofs: 0,
  suggestions: 0,
  removed: 0,
}

export const teamShape = defineShape<TeamShape, TeamData>({
  page: "team",
  fallback: FALLBACK,
  of: () => FALLBACK,
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const members = count(r.members, MAX_TEAM_MEMBERS)
    const invites = count(r.invites, MAX_TEAM_ROWS)
    const requests = count(r.requests, MAX_TEAM_ROWS)
    const waiting = count(r.waiting, MAX_TEAM_ROWS)
    const domains = count(r.domains, MAX_TEAM_ROWS)
    const proofs = count(r.proofs, MAX_TEAM_ROWS)
    const suggestions = count(r.suggestions, MAX_TEAM_ROWS)
    const removed = count(r.removed, MAX_TEAM_ROWS)
    if (
      members === null ||
      invites === null ||
      requests === null ||
      waiting === null ||
      domains === null ||
      proofs === null ||
      suggestions === null ||
      removed === null
    )
      return null
    return {
      members,
      canManage: r.canManage === true,
      capacity: r.capacity === true,
      invitable: r.invitable === true,
      invites,
      requests,
      waiting: Math.min(waiting, requests),
      full: r.full === true,
      accessDomains: r.accessDomains === true,
      domains,
      proofs: Math.min(proofs, domains),
      suggestions,
      removed,
    }
  },
})
