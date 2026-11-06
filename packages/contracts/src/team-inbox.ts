import { z } from "zod"
import { mailboxAddressSchema } from "./mailbox.js"

/**
 * Team inboxes - a shared address such as support@ that several people read.
 *
 * ⚠ OURS, LIKE `mailbox.ts`, AND IDENTIFIED THE SAME WAY: BY ADDRESS. Members are
 * named by the mailbox address they already hold, never by Clerk user id, which
 * is the one value that must stay out of URLs, bodies and logs. The server turns
 * an address into a person; a request cannot name a person directly.
 */

/** A person with a mailbox, named by that mailbox's address. */
export const teamInboxMemberSchema = z.object({
  address: z.string(),
})

export const createTeamInboxSchema = z.object({
  /** On a domain the workspace has verified; the server checks, not this schema. */
  address: mailboxAddressSchema,
  /** The name shown for the inbox. Defaults to the address. */
  display_name: z.string().trim().min(1).max(255).optional(),
  /**
   * Mailbox addresses of the people who can read and send from it. At least one:
   * an inbox nobody can open is a mistake worth refusing.
   */
  members: z.array(mailboxAddressSchema).min(1).max(100),
})

/** The whole set, replacing the old one. Idempotent, so a retry is harmless. */
export const setTeamInboxMembersSchema = z.object({
  members: z.array(mailboxAddressSchema).min(1).max(100),
})

export const teamInboxSchema = z.object({
  object: z.literal("team_inbox"),
  address: z.string(),
  display_name: z.string().nullable(),
  members: z.array(teamInboxMemberSchema),
  created_at: z.string(),
})

export const teamInboxListSchema = z.object({
  data: z.array(teamInboxSchema),
})

export type CreateTeamInbox = z.infer<typeof createTeamInboxSchema>
export type SetTeamInboxMembers = z.infer<typeof setTeamInboxMembersSchema>
export type TeamInbox = z.infer<typeof teamInboxSchema>
