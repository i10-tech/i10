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
          diagnostic: "smtp; 550 5.1.1 user unknown",
        },
      }
    case "email.complained":
      return { ...base, complaint: { type: "abuse", recipients: ["ada@example.com"] } }
    case "email.delivery_delayed":
      return {
        ...base,
        delay: {
          type: "MailboxFull",
          recipients: ["ada@example.com"],
          next_retry: null,
        },
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
    case "email.unsubscribed":
      return { ...base, unsubscribe: { list: "newsletter", source: "header" } }
    case "email.sent":
    case "email.delivered":
      return base
    case "member.provisioned":
      return {
        user_id: "user_00000000000000000000000000",
        connection_id: "00000000-0000-7000-8000-000000000002",
        source: "jit",
        created_at: at.toISOString(),
        test: true,
      }
    case "member.deprovisioned":
      return {
        user_id: "user_00000000000000000000000000",
        connection_id: "00000000-0000-7000-8000-000000000002",
        mode: "membership",
        cause: "scim",
        actor_user_id: null,
        sessions_revoked: 2,
        api_keys: [{ id: "00000000-0000-7000-8000-000000000003", name: "Production" }],
        created_at: at.toISOString(),
        test: true,
      }
    case "sso.connection.failed":
      return {
        connection_id: "00000000-0000-7000-8000-000000000002",
        reason: "signature_invalid",
        trigger: "failure_spike",
        failures_last_hour: 42,
        failures_last_24h: 57,
        last_success_at: new Date(at.getTime() - 3 * 3_600_000).toISOString(),
        created_at: at.toISOString(),
        test: true,
      }
    case "sso.certificate.expiring":
      return {
        connection_id: "00000000-0000-7000-8000-000000000002",
        fingerprint: "3fa9c1d2e4b5a6978877665544332211ffeeddccbbaa99887766554433221100",
        not_after: new Date(at.getTime() + 7 * 86_400_000).toISOString(),
        days: 7,
        created_at: at.toISOString(),
        test: true,
      }
    case "webhook_endpoint.failing":
    case "webhook_endpoint.disabled":
    case "webhook_endpoint.recovered": {
      const recovered = type === "webhook_endpoint.recovered"
      return {
        endpoint_id: "00000000-0000-7000-8000-000000000001",
        url: "https://example.com/webhooks/i10",
        reason: recovered
          ? null
          : type === "webhook_endpoint.disabled"
            ? "No successful delivery for 5 days."
            : "HTTP 503",
        failing_since: recovered
          ? null
          : new Date(at.getTime() - 15 * 60_000).toISOString(),
        created_at: at.toISOString(),
        test: true,
      }
    }
  }
}
