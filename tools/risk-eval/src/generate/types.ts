/**
 * The vocabulary of the legitimate-mail generator: what a template is made of
 * and what one generated mail records about where it came from.
 */

/** ISO 639-1 codes, set by hand on every template and never detected. */
export const LANGS = ["en", "ar", "es", "pt", "fr", "de", "ja", "id", "zh"] as const
export type Lang = (typeof LANGS)[number]

/** The house style a template is written in; it also picks the HTML look. */
export const STYLES = [
  "dev-terse",
  "consumer-friendly",
  "formal-bank",
  "small-shop",
] as const
export type Style = (typeof STYLES)[number]

/** Mail types an honest service sends all the time. */
export const ORDINARY_TYPES = [
  "password-reset",
  "email-verification",
  "otp-code",
  "magic-link",
  "new-device-alert",
  "password-changed",
  "two-factor-changed",
  "team-invitation",
  "welcome",
  "order-confirmation",
  "receipt",
  "payment-failed",
  "renewal-reminder",
  "trial-ending",
  "refund-issued",
  "shipping-notice",
  "delivery-update",
  "booking-confirmation",
  "support-reply",
  "comment-mention",
  "weekly-digest",
  "export-ready",
  "api-key-created",
  "usage-limit-warning",
  "account-deletion",
  "newsletter",
  "changelog",
] as const

/**
 * Legitimate mail that is hardest to tell from phishing: urgent, security
 * flavoured, with a link and a deadline, sent by a service that really sends
 * it. These are reported as their own slice.
 */
export const HARD_NEGATIVE_TYPES = [
  "urgent-security-alert",
  "payment-failed-final",
  "account-suspension",
  "verify-deadline",
  "bank-transaction-review",
] as const

export const MAIL_TYPES = [...ORDINARY_TYPES, ...HARD_NEGATIVE_TYPES] as const
export type MailType = (typeof MAIL_TYPES)[number]

export function isHardNegativeType(type: MailType): boolean {
  return (HARD_NEGATIVE_TYPES as readonly string[]).includes(type)
}

/** Types that carry an unsubscribe line, as real marketing mail does. */
export const MARKETING_TYPES: readonly MailType[] = ["newsletter", "changelog"]

/**
 * One piece of a mail body. The same blocks render to plain text and to HTML,
 * so the two bodies of a mail always say the same thing.
 *
 * - a string is a paragraph (`\n` is a line break)
 * - `cta` is a button: a label and the link behind it
 * - `code` is a one-time code, shown large
 * - `rows` is a small table of label and value
 * - `list` is a bullet list
 * - `note` is small print inside the body
 * - `lines` is the order's line items with subtotal, shipping and total
 */
export type Block =
  | string
  | { cta: string; url: string }
  | { code: string }
  | { rows: [label: string, value: string][] }
  | { list: string[] }
  | { note: string }
  | { lines: "order" }

/**
 * Authored text with holes. Inside any string:
 * - `{name}` is a placeholder, filled from the generated context (fill.ts);
 *   `{link:path}` is a link to `path` on the sender's own fictional domain.
 * - `[[a|b|c]]` is a choice between wordings, made once per mail.
 */
export interface Template {
  /** Unique and stable: it seeds every mail made from the template. */
  id: string
  type: MailType
  style: Style
  lang: Lang
  /** Alternative subjects; one is chosen per mail. */
  subject: string[]
  body: Block[]
}

/** A mail as the generator makes it, before it becomes a normalised record. */
export interface GeneratedMail {
  /** Stable source key: `<template id>#<index>`. */
  key: string
  templateId: string
  type: MailType
  style: Style
  lang: Lang
  hardNegative: boolean
  subject: string
  text: string
  html: string
  fromDomain: string
}
