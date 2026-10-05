import type { WebhookEventType } from "./events.js"

/**
 * A realistic `data` for every event type, for test events (#281) and the
 * event catalog's examples (#283).
 *
 * ⚠ THE SAME SHAPE events.ts BUILDS FROM A REAL SES NOTIFICATION, field for
 * field, so a receiver tested against these handles the real thing. The
 * addresses are example.com, the ids say they are tests, and `test: true` is
 * on every one so a receiver can tell.
 */
export function exampleData(
  type: WebhookEventType,
  at = new Date(),
): Record<string, unknown> {
  const base = {
    email_id: "00000000-0000-7000-8000-000000000000",
    from: "Acme <hello@example.com>",
    to: ["ada@example.com"],
    subject: "Your receipt from Acme",
    created_at: at.toISOString(),
    tags: { category: "receipt" },
    test: true,
  }
  switch (type) {
    case "email.bounced":
      return {
        ...base,
        bounce: {
          type: "permanent",
          subtype: "general",
          recipients: ["ada@example.com"],
        },
      }
    case "email.complained":
      return { ...base, complaint: { type: "abuse", recipients: ["ada@example.com"] } }
    case "email.delivery_delayed":
      return {
        ...base,
        delay: { type: "MailboxFull", recipients: ["ada@example.com"] },
      }
    case "email.failed":
      return { ...base, reason: "Bad content" }
    case "email.opened":
      return { ...base, open: { user_agent: "Mozilla/5.0 (Macintosh)" } }
    case "email.clicked":
      return {
        ...base,
        click: {
          link: "https://example.com/orders/1042",
          user_agent: "Mozilla/5.0 (Macintosh)",
        },
      }
    case "email.sent":
    case "email.delivered":
    case "email.unsubscribed":
      return base
  }
}
