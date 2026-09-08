import { z } from "zod"

/**
 * Human mailboxes — the IMAP/SMTP side of i10, not the sending API.
 *
 * ⚠ THIS ONE IS OURS, NOT RESEND'S. Every other contract in this package is
 * shaped so `resend/node` → `@i10/node` is a one-line change; Resend has no
 * concept of a mailbox at all, so there is no envelope to copy and nothing a
 * customer's existing code can be broken by. The error shape stays theirs
 * because it is shared across the whole API.
 *
 * ⚠ AND THE ADDRESS IS THE IDENTIFIER, DELIBERATELY. `authd.accounts` is keyed
 * by Clerk's user id, which is the one value we must never put in a URL: it is
 * the subject of the bind authd delegates, and leaking it into logs and browser
 * history buys nothing a customer can use. The address is unique, is what the
 * person types into Apple Mail, and is what they would search for.
 */

/**
 * A whole address, lowercased.
 *
 * ⚠ VALIDATED HERE ONLY AS FAR AS "COULD BE ONE". Whether the domain is one we
 * host, whether it is verified, and whether the address is taken are all
 * questions for the provisioning core — they need the database, and a zod
 * schema that pretended to answer them would be a second, weaker copy of the
 * rules that actually matter.
 */
export const mailboxAddressSchema = z
  .string()
  .min(3)
  .max(254)
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "must be an email address")

export const createMailboxSchema = z.object({
  /**
   * ⚠ NO `user_id`, AND ITS ABSENCE IS THE WHOLE ACCESS CONTROL MODEL OF THIS
   * ROUTE. A mailbox is always created for the caller, so there is no field an
   * attacker could point at somebody else. Provisioning on another person's
   * behalf is the invite flow, which is a different endpoint with a different
   * authorisation question ("does this admin own the domain and have a seat
   * left"), and folding it in here as an optional field would mean one route
   * answering two of them.
   */
  address: mailboxAddressSchema,
  /** Shown in mail clients. Defaults to the Clerk profile name. */
  display_name: z.string().max(255).optional(),
})

export const mailboxSchema = z.object({
  object: z.literal("mailbox"),
  address: z.string(),
  display_name: z.string().nullable(),
  /**
   * Whether the mailbox accepts mail and may bind right now.
   *
   * ⚠ IT IS THE SUBSCRIPTION GATE, NOT A CREATION RESULT, so it is reported
   * rather than assumed. A mailbox whose plan lapses stays here and goes
   * `false`; the address remains reserved and the storage remains counted.
   */
  active: z.boolean(),
  created_at: z.string(),
})

export const mailboxListSchema = z.object({
  data: z.array(mailboxSchema),
})

export type CreateMailbox = z.infer<typeof createMailboxSchema>
export type Mailbox = z.infer<typeof mailboxSchema>
