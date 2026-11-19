import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { ConsoleMailbox, StoragePool } from "@/lib/mailbox-view"
import type { CreateMailboxProps } from "@/components/mailboxes-view"

/** What the mailboxes page loads. `error` replaces the list, not the page. */
export interface MailboxesData {
  mailboxes: ConsoleMailbox[]
  pool: StoragePool
  nextCursor: string | null
  isAdmin: boolean
  /** The workspace lets members create their own (mode `members` or `on_join`). */
  selfServe: boolean
  create: CreateMailboxProps
  error?: string
}

export interface MailboxesShape {
  /** An owner or admin sees every mailbox; a member sees their own. */
  admin: boolean
  /** Rows to draw, capped; 0 is the empty state. A member's is 0 or 1. */
  rows: number
  /** Some domain hosts mailboxes, so the empty state offers Create. */
  hosted: boolean
  /** A member may create their own, so their empty state offers it. */
  selfServe: boolean
  /** The pool is a meter (a capped pool) rather than a line of text. */
  meter: boolean
  /** Some mailboxes have no storage allocation yet, so a note says so. */
  unallocated: boolean
  /** A cursor leads to a next page. */
  more: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const mailboxesShape = defineShape<MailboxesShape, MailboxesData>({
  page: "mailboxes",
  // A first visit draws the admin's list: the common case, and the one with most to draw.
  fallback: {
    admin: true,
    rows: 3,
    hosted: true,
    selfServe: false,
    meter: false,
    unallocated: false,
    more: false,
  },
  of: (data) => ({
    admin: data.isAdmin,
    rows: Math.min(data.mailboxes.length, data.isAdmin ? MAX_SKELETON_ROWS : 1),
    hosted: data.create.domains.length > 0,
    selfServe: data.selfServe,
    meter: data.pool.kind === "pool" && data.pool.total != null,
    unallocated: data.pool.unallocated > 0,
    more: data.nextCursor !== null,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const rows = count(r.rows, MAX_SKELETON_ROWS)
    if (rows === null) return null
    return {
      admin: r.admin === true,
      rows,
      hosted: r.hosted === true,
      selfServe: r.selfServe === true,
      meter: r.meter === true,
      unallocated: r.unallocated === true,
      more: r.more === true,
    }
  },
})
