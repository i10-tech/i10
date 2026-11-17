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

/**
 * An owner or admin giving an existing member of the workspace a mailbox.
 *
 * ⚠ THE ONE PLACE A REQUEST NAMES ANOTHER PERSON, which is why it is its own
 * schema and not an optional field on `createMailboxSchema` (see the note
 * there). `user_id` is the workspace member's id as the Team page already
 * carries it (`/team/members/:userId/...`); the route answers 404 for anybody
 * who is not a member of the caller's workspace, so it cannot be used to ask
 * whether some other id exists.
 */
export const adminCreateMailboxSchema = createMailboxSchema.extend({
  user_id: z.string().min(1).max(128),
})

/**
 * Who creates mailboxes in a workspace.
 *
 *   - `admins`: owners and admins only. The default.
 *   - `members`: people may also create their own.
 *   - `on_join`: everyone gets one when they join (a workspace with exactly one
 *     hosted domain), and members may still create their own.
 */
export const mailboxCreationModeSchema = z.enum(["admins", "members", "on_join"])

export const mailboxCreationSettingsSchema = z.object({
  mode: mailboxCreationModeSchema,
})

export const setMailboxCreationSchema = mailboxCreationSettingsSchema

/** How long a deleted mailbox can be restored, in days. Then it is purged. */
export const MAILBOX_DELETE_GRACE_DAYS = 30

/**
 * What happens to the address and its mail when an owner or admin deletes a
 * mailbox. Sign-in stops at once for all three, and each can be restored for
 * `MAILBOX_DELETE_GRACE_DAYS`.
 *
 *   - `delete`: after the grace the account, its mail and the address go.
 *   - `export_then_delete`: an export of the mail is started now, and the purge
 *     waits until it has finished and its download has been available for its
 *     whole retention.
 *   - `forward`: after the grace the address stays and delivers to another
 *     mailbox of the workspace (`forward_to`).
 */
export const mailboxDeletionOutcomeSchema = z.enum([
  "delete",
  "export_then_delete",
  "forward",
])

export const deleteMailboxSchema = z
  .object({
    outcome: mailboxDeletionOutcomeSchema,
    /**
     * Forward only: the address of the mailbox that receives this one's mail.
     *
     * ⚠ AN ADDRESS, AS EVERY MAILBOX ROUTE NAMES ONE. Whether it is a live
     * mailbox of this workspace is the route's question, not this schema's.
     */
    forward_to: mailboxAddressSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === "forward" && !value.forward_to) {
      ctx.addIssue({
        code: "custom",
        path: ["forward_to"],
        message: "forward_to is required when the outcome is forward.",
      })
    }
    if (value.outcome !== "forward" && value.forward_to) {
      ctx.addIssue({
        code: "custom",
        path: ["forward_to"],
        message: "forward_to is only allowed when the outcome is forward.",
      })
    }
  })

/**
 * How many aliases an owner or admin may give ONE mailbox through the console.
 *
 * ⚠ THE ONES A DIRECTORY OR CLERK GIVE ARE NOT COUNTED. They are not the admin's
 * to add, so a directory that lists forty addresses must not lock the admin out
 * of adding the one they came for. Every alias is served to the mail server as an
 * attribute of the person's entry on every lookup, so the number is kept modest.
 */
export const MAILBOX_ALIAS_LIMIT = 30

/**
 * Where an alias came from, which decides who can remove it.
 *
 *   - `console`: an owner or admin added it. The only kind this API removes.
 *   - `clerk`: a verified address on the person's own account, so also a sign-in
 *     address. Removed by the person, at their account.
 *   - `directory`: listed by the company's directory, removed there.
 */
export const mailboxAliasSourceSchema = z.enum(["console", "clerk", "directory"])

/**
 * An address on any domain the workspace hosts mail on, that delivers to the
 * mailbox and may be sent from.
 *
 * ⚠ VALIDATED HERE ONLY AS FAR AS THE SHAPE. The local part is held to the
 * characters every mail server agrees on, lowercased: `+` is refused because the
 * mail server strips a `+tag` before it looks an address up, so such an alias
 * would never match anything. Whether the domain is the workspace's, and whether
 * the address is free, are the store's questions.
 */
export const mailboxAliasAddressSchema = mailboxAddressSchema.refine((v) => {
  const local = v.slice(0, v.lastIndexOf("@"))
  return (
    local.length <= 64 &&
    /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(local) &&
    !local.includes("..")
  )
}, "The part before the @ may use letters, digits, dots, hyphens and underscores, and must start and end with a letter or digit.")

export const addMailboxAliasSchema = z.object({
  address: mailboxAliasAddressSchema,
})

export const mailboxAliasSchema = z.object({
  object: z.literal("mailbox_alias"),
  address: z.string(),
  source: mailboxAliasSourceSchema,
  /** Whether `DELETE` removes it: only an alias an owner or admin added. */
  removable: z.boolean(),
})

export const mailboxAliasListSchema = z.object({
  data: z.array(mailboxAliasSchema),
  /** The most console aliases one mailbox may have. */
  limit: z.number().int().positive(),
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

export const mailboxJobProgressSchema = z.object({
  total_messages: z.number().int().nonnegative(),
  processed_messages: z.number().int().nonnegative(),
  total_folders: z.number().int().nonnegative(),
  processed_folders: z.number().int().nonnegative(),
})

/** Where an import's archive goes: straight to storage, not through the API. */
export const mailboxJobUploadSchema = z.object({
  url: z.string(),
  method: z.literal("PUT"),
  expires_at: z.string(),
})

export const createMailboxImportSchema = z.object({
  /** The archive's size in bytes, so an oversize one is refused before it is sent. */
  size: z.number().int().positive(),
})

export const mailboxJobSchema = z.object({
  object: z.literal("mailbox_job"),
  id: z.string(),
  mailbox_address: z.string(),
  type: z.enum(["export", "import"]),
  status: z.enum(["awaiting_upload", "pending", "running", "completed", "failed"]),
  progress: mailboxJobProgressSchema,
  download_url: z.string().nullable().optional(),
  upload: mailboxJobUploadSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  created_at: z.string(),
  completed_at: z.string().nullable().optional(),
})

export type CreateMailbox = z.infer<typeof createMailboxSchema>
export type AdminCreateMailbox = z.infer<typeof adminCreateMailboxSchema>
export type MailboxDeletionOutcome = z.infer<typeof mailboxDeletionOutcomeSchema>
export type DeleteMailbox = z.infer<typeof deleteMailboxSchema>
export type MailboxCreationMode = z.infer<typeof mailboxCreationModeSchema>
export type MailboxCreationSettings = z.infer<typeof mailboxCreationSettingsSchema>
export type Mailbox = z.infer<typeof mailboxSchema>
export type MailboxAliasSource = z.infer<typeof mailboxAliasSourceSchema>
export type AddMailboxAlias = z.infer<typeof addMailboxAliasSchema>
export type MailboxAlias = z.infer<typeof mailboxAliasSchema>
export type MailboxAliasList = z.infer<typeof mailboxAliasListSchema>
export type SetMailboxStorage = z.infer<typeof setMailboxStorageSchema>
export type MailboxStorage = z.infer<typeof mailboxStorageSchema>
export type StoragePool = z.infer<typeof storagePoolSchema>
export type MailboxStorageList = z.infer<typeof mailboxStorageListSchema>

export type MailboxJobProgress = z.infer<typeof mailboxJobProgressSchema>
export type MailboxJob = z.infer<typeof mailboxJobSchema>
export type CreateMailboxImport = z.infer<typeof createMailboxImportSchema>
