import { z } from "zod"

/**
 * Human mailboxes - the IMAP/SMTP side of i10, not the sending API.
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
 * questions for the provisioning core - they need the database, and a zod
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
  /**
   * Bytes of the workspace's storage to give this mailbox.
   *
   * ⚠ ONLY AN OWNER OR ADMIN OF THE WORKSPACE MAY SEND IT, AND A MEMBER WHO DOES
   * IS REFUSED (403), NOT IGNORED. An allocation takes from a pool the workspace
   * shares, so the person who will use the inbox must not be the one who sizes
   * it. A prepaid plan REQUIRES it (422 without); pay as you go takes it as an
   * optional cap. Zero is not a value: the mail server may read it as unlimited.
   */
  storage_allocation: z.number().int().positive().optional(),
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
  /**
   * Storage an owner or admin allocated to this inbox, in bytes. Null when none
   * is: uncapped on pay as you go, or not yet allocated on a plan.
   */
  storage_allocated: z.number().int().positive().nullable().optional(),
})

export const mailboxListSchema = z.object({
  data: z.array(mailboxSchema),
})

/**
 * Splitting the workspace's storage across its inboxes - the console's, for an
 * owner or admin.
 *
 * ⚠ NO ROUTE A MEMBER REACHES. An allocation takes from a shared pool, so
 * letting the person who will use the inbox set it lets them take the pool. It
 * is its own request, answered only for a workspace's owners and admins, and it
 * names the mailbox in the path.
 */
export const setMailboxStorageSchema = z.object({
  /**
   * Bytes for this inbox. A positive whole number, or `null` to remove a cap.
   *
   * ⚠ `null` IS ONLY ACCEPTED ON PAY AS YOU GO. A prepaid plan needs a number
   * for every inbox, so the pool is the sum of something. Zero is not a value:
   * the mail server may read it as unlimited.
   */
  storage_allocation: z.number().int().positive().nullable(),
})

export const mailboxStorageSchema = z.object({
  address: z.string(),
  display_name: z.string().nullable(),
  storage_allocated: z.number().int().positive().nullable(),
})

export const storagePoolSchema = z.object({
  /** `pool`: a prepaid plan, split by the admin. `uncapped`: pay as you go. */
  kind: z.enum(["pool", "uncapped"]),
  /** The prepaid pool in bytes. Null when uncapped. */
  total: z.number().int().nonnegative().nullable(),
  allocated: z.number().int().nonnegative(),
  /** What the workspace's mailboxes occupy, from the last storage sample. */
  used: z.number().int().nonnegative(),
  /** Pool minus allocated. Null when uncapped. */
  remaining: z.number().int().nonnegative().nullable(),
  /**
   * Inboxes on a pool that have no allocation yet.
   *
   * ⚠ THEY HAVE A HIGH DEFAULT QUOTA, WHICH IS OUTSIDE THE POOL. They predate
   * allocation; the console should prompt the admin to give each a number.
   */
  unallocated: z.number().int().nonnegative(),
})

export const mailboxStorageListSchema = z.object({
  pool: storagePoolSchema,
  data: z.array(mailboxStorageSchema),
})

export const mailboxStorageUpdatedSchema = z.object({
  mailbox: mailboxStorageSchema,
  /**
   * `synced`: the mail server has the quota. `deferred`: the allocation is
   * saved and the next reconcile applies it.
   */
  quota: z.enum(["synced", "deferred"]),
})

export type CreateMailbox = z.infer<typeof createMailboxSchema>
export type Mailbox = z.infer<typeof mailboxSchema>
export type SetMailboxStorage = z.infer<typeof setMailboxStorageSchema>
export type MailboxStorage = z.infer<typeof mailboxStorageSchema>
export type StoragePool = z.infer<typeof storagePoolSchema>
export type MailboxStorageList = z.infer<typeof mailboxStorageListSchema>
