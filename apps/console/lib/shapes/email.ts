import { defineShape } from "@/lib/shapes"
import { emailJourney, eventLogRows } from "@/lib/journey"
import type { EmailDetail, EmailRow } from "@/lib/types"

export interface EmailData {
  email: EmailDetail
}

export interface EmailShape {
  to: number
  cc: number
  bcc: number
  replyTo: number
  attachments: number
  steps: number
  error: boolean
  tags: number
  broadcast: boolean
  scheduled: boolean
  sent: boolean
  attempts: number
  /** Rows in the event log beside the message, capped. */
  log: number
  /** Whether the provider has a message id for it (set once it was handed on). */
  provider: boolean
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export const emailShape = defineShape<EmailShape, EmailData>({
  page: "email",
  fallback: {
    to: 1,
    cc: 0,
    bcc: 0,
    replyTo: 0,
    attachments: 0,
    steps: 3,
    error: false,
    tags: 0,
    broadcast: false,
    scheduled: false,
    sent: true,
    attempts: 1,
    log: 3,
    provider: false,
  },
  of: ({ email }) => ({
    to: email.to.length,
    cc: email.cc?.length ?? 0,
    bcc: email.bcc?.length ?? 0,
    replyTo: email.reply_to?.length ?? 0,
    attachments: email.attachments?.length ?? 0,
    steps: emailJourney(email).length,
    error: Boolean(email.last_error),
    tags: email.tags ? Object.keys(email.tags).length : 0,
    broadcast: Boolean(email.broadcast_id),
    scheduled: Boolean(email.scheduled_at),
    sent: Boolean(email.sent_at),
    attempts: email.attempts ?? 1,
    log: Math.min(eventLogRows(email.events ?? [], email.scheduled_at), 10),
    provider: Boolean(email.provider_message_id),
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    return {
      to: count(r.to, 50) ?? 1,
      cc: count(r.cc, 50) ?? 0,
      bcc: count(r.bcc, 50) ?? 0,
      replyTo: count(r.replyTo, 50) ?? 0,
      attachments: count(r.attachments, 50) ?? 0,
      steps: count(r.steps, 10) ?? 3,
      error: r.error === true,
      tags: count(r.tags, 50) ?? 0,
      broadcast: r.broadcast === true,
      scheduled: r.scheduled === true,
      sent: r.sent !== false,
      attempts: count(r.attempts, 100) ?? 1,
      log: count(r.log, 10) ?? 3,
      // Cookies written before these fields existed read as "none".
      provider: r.provider === true,
    }
  },
})

/**
 * Builds a seed shape from what a list row knows, so navigation into
 * the email detail page renders an exact skeleton on the first frame.
 */
export function emailShapeFromRow(row: EmailRow): EmailShape {
  return {
    to: row.to.length,
    cc: 0,
    bcc: 0,
    replyTo: 0,
    attachments: 0,
    steps: 3,
    error: Boolean(row.last_error),
    tags: 0,
    broadcast: false,
    scheduled: Boolean(row.scheduled_at),
    sent: Boolean(row.sent_at),
    attempts: 1,
    log: 3,
    provider: Boolean(row.sent_at),
  }
}
