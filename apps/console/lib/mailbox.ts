import type { LeaverAction, LoginBlock, MailboxNext, MailboxRow } from "./sso-types"

/**
 * Directory mail (#344): the words for what happens to a person's mailbox when
 * a directory switches them off, and the date a deletion lands on.
 */

export const LEAVER_LABEL: Record<LeaverAction, string> = {
  keep: "Keep the mailbox",
  forward_manager: "Forward to their manager",
  delete_after: "Delete after a set time",
}

export const LEAVER_HELP: Record<LeaverAction, string> = {
  keep: "The mailbox stays, suspended, until an admin decides.",
  forward_manager: "New mail is copied to their manager. The mailbox is kept.",
  delete_after:
    "The mailbox and its mail are deleted this many days after the person is switched off.",
}

export const NEXT_LABEL: Record<MailboxNext, string> = {
  keep: "Keep it",
  forward_manager: "Forward to their manager",
  delegate: "Give someone access",
  delete: "Delete it",
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The moment a deletion chosen now, `days` from now, will happen. */
export function deletionDate(days: number, from: Date): Date {
  return new Date(from.getTime() + days * DAY_MS)
}

/** Whether `days` is a whole number inside the API's bounds. */
export function daysInRange(
  days: number,
  limits: { minDays: number; maxDays: number },
): boolean {
  return Number.isInteger(days) && days >= limits.minDays && days <= limits.maxDays
}

const BLOCK_REASON: Record<LoginBlock, string> = {
  payment_hold: "the workspace's plan is unpaid",
  banned: "the account is banned",
  locked: "the account is locked",
}

/**
 * What to tell an owner once a mailbox is resumed. A resume lifts the suspension
 * and nothing else, so a payment hold or a ban that is still there is said, not
 * left for them to find out from a person who still cannot sign in.
 */
export function resumeNote(address: string, blocks: readonly LoginBlock[]): string {
  if (blocks.length === 0) return `${address} can sign in again.`
  const why = blocks.map((b) => BLOCK_REASON[b])
  const list =
    why.length === 1
      ? why[0]
      : `${why.slice(0, -1).join(", ")} and ${why[why.length - 1]}`
  return `${address} is resumed, but it cannot sign in yet: ${list}.`
}

/** One line on what a suspended mailbox is set to do, for its row. */
export function nextSummary(
  row: Pick<MailboxRow, "next" | "deleteAfterDays" | "targetUserId">,
  nameOf: (userId: string) => string,
): string {
  switch (row.next) {
    case "keep":
      return "Kept as it is."
    case "forward_manager":
      return "Forwarded to their manager."
    case "delegate":
      return row.targetUserId
        ? `Open to ${nameOf(row.targetUserId)}.`
        : "Open to a delegate."
    case "delete":
      return row.deleteAfterDays === null
        ? "To be deleted."
        : `Deleted ${row.deleteAfterDays} days after they were switched off.`
  }
}
