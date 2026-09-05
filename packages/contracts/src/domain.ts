import { z } from "zod"

/**
 * Domains, shaped to be a drop-in for Resend's.
 *
 * ⚠ COMPATIBILITY HERE MEANS THE ENVELOPE, NOT THE RECORD VALUES. A customer's
 * SDK call, the JSON keys it reads, and the status strings it compares against
 * are the things that must match; what goes in `records[].value` is whoever is
 * actually sending the mail. Ours names Amazon because we run on SES.
 *
 * ⚠ AND THE STATUS STRINGS ARE A PUBLIC CONTRACT THE MOMENT THIS SHIPS. They
 * arrive in customer code as literals in `if (domain.status === "verified")`.
 * Add to them, never rename — the same rule as `webhookEventName`.
 */

export const domainStatus = z.enum([
  "not_started",
  "pending",
  "verified",
  "failed",
  "temporary_failure",
])

/**
 * What the customer has to publish, and whether we have seen it yet.
 *
 * ⚠ `ttl` IS A STRING BECAUSE RESEND'S IS. It carries "Auto" as often as a
 * number, and a customer pasting it into a DNS provider needs the value they
 * were given rather than one we normalised.
 */
export const dnsRecordSchema = z.object({
  /** `SPF` or `DKIM`. What the record is for, not its DNS type. */
  record: z.string(),
  name: z.string(),
  type: z.enum(["MX", "TXT", "CNAME"]),
  ttl: z.string(),
  status: domainStatus,
  value: z.string(),
  /** MX only. */
  priority: z.number().int().optional(),
})

export const createDomainSchema = z.object({
  /**
   * ⚠ THE APEX, NOT A URL AND NOT AN ADDRESS. `example.com`, never
   * `https://example.com` or `me@example.com` — both are things people paste,
   * and both would create a domain that can never verify.
   */
  name: z.string().min(1).max(253),
  /**
   * The subdomain used as the MAIL FROM / return path. Resend calls this
   * `custom_return_path` and defaults it to `send`.
   */
  custom_return_path: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i, "must be a single DNS label")
    .optional(),
  /**
   * ⚠ ACCEPTED AND IGNORED, BECAUSE WE RUN IN ONE REGION. Rejecting it would
   * break a Resend caller that always sends it; honouring it would be a lie.
   * The response always reports the region the mail actually leaves from.
   */
  region: z.string().optional(),
})

export const domainSchema = z.object({
  object: z.literal("domain"),
  id: z.uuid(),
  name: z.string(),
  status: domainStatus,
  created_at: z.string(),
  region: z.string(),
  records: z.array(dnsRecordSchema),
})

/** ⚠ NO `records`. Resend's list is the summary; the records are on the get. */
export const domainSummarySchema = z.object({
  object: z.literal("domain"),
  id: z.uuid(),
  name: z.string(),
  status: domainStatus,
  created_at: z.string(),
  region: z.string(),
})

export const domainListSchema = z.object({
  data: z.array(domainSummarySchema),
})

export const deletedDomainSchema = z.object({
  object: z.literal("domain"),
  id: z.uuid(),
  deleted: z.literal(true),
})

export const verifyDomainSchema = z.object({
  object: z.literal("domain"),
  id: z.uuid(),
})

export type DomainStatus = z.infer<typeof domainStatus>
export type DnsRecord = z.infer<typeof dnsRecordSchema>
export type CreateDomain = z.infer<typeof createDomainSchema>
export type Domain = z.infer<typeof domainSchema>
export type DomainSummary = z.infer<typeof domainSummarySchema>
