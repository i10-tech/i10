import { z } from "zod"

/**
 * Mail devices (#383): an iPhone, iPad or Mac that signs in to a mailbox with
 * its own device code instead of the person's password. Revoking one deletes
 * it, and its open mail connections close within about a second.
 *
 * ⚠ NEVER THE CODE OR ANY HASH OF IT, and never the certificate key's hash:
 * only whether a Mac has a key bound.
 */
export const mailDevicePlatformSchema = z.enum(["ios", "ipados", "macos"])

export const mailDeviceSchema = z.object({
  object: z.literal("mail_device"),
  id: z.string(),
  /** The mailbox address the device signs in to. */
  email: z.string(),
  platform: mailDevicePlatformSchema,
  device_name: z.string().nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  created_at: z.string(),
  /** Null until the device first signs in with its code. */
  first_used_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  /** Who added it: a person's id, or the system that did. */
  created_by: z.string(),
  /** Whether a Mac has bound its certificate key. Always false on iOS and iPadOS. */
  has_certificate_key: z.boolean(),
})

export const mailDeviceListSchema = z.object({
  data: z.array(mailDeviceSchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  next_cursor: z.string().nullable(),
})

export const mailDevicesRevokedSchema = z.object({
  object: z.literal("mail_devices_revoked"),
  /** How many devices were signed out. */
  revoked: z.number().int().nonnegative(),
})

export type MailDevice = z.infer<typeof mailDeviceSchema>
export type MailDeviceList = z.infer<typeof mailDeviceListSchema>
