import { describe, expect, it } from "bun:test"
import {
  WEBHOOK_EVENT_CATALOG,
  webhookEventData,
  webhookEventName,
  webhookPayloadSchema,
} from "@repo/contracts"
import { envelope, interpretSesEvent } from "../src/webhooks/events.js"
import { exampleData } from "../src/webhooks/examples.js"
import { interpretStalwartEvent, type StalwartEvent } from "../src/webhooks/stalwart.js"

/**
 * The event catalog's contract tests (#283).
 *
 * ⚠ EVERY PAYLOAD WE CAN EMIT, THROUGH THE STRICT SCHEMA, FROM BOTH MAIL
 * SERVERS. A field added in an interpreter but not in the catalog fails here,
 * as does one the catalog promises that an interpreter stopped sending - and
 * so does a shape that differs between SES and Stalwart for the same event,
 * which a customer must never be able to see.
 */

const MESSAGE_ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const AT = "2026-10-05T12:00:00.000Z"

const ses = (eventType: string, extra: Record<string, unknown> = {}) => ({
  eventType,
  mail: {
    timestamp: AT,
    source: "Acme <hello@acme.test>",
    destination: ["ada@example.com"],
    commonHeaders: { subject: "Your receipt" },
    tags: {
      i10_message_id: [MESSAGE_ID],
      category: ["receipt"],
      // Neither of these is the customer's; both must be dropped.
      "ses:source-ip": ["203.0.113.9"],
      "ses:caller-identity": ["i10"],
    },
  },
  ...extra,
})

const SES_EVENTS: Record<string, ReturnType<typeof ses>> = {
  "email.sent": ses("Send"),
  "email.delivered": ses("Delivery", { delivery: { timestamp: AT } }),
  "email.delivery_delayed": ses("DeliveryDelay", {
    deliveryDelay: {
      timestamp: AT,
      delayType: "MailboxFull",
      delayedRecipients: [{ emailAddress: "ada@example.com" }],
    },
  }),
  "email.bounced": ses("Bounce", {
    bounce: {
      timestamp: AT,
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [
        { emailAddress: "ada@example.com", diagnosticCode: "smtp; 550 5.1.1" },
      ],
    },
  }),
  "email.complained": ses("Complaint", {
    complaint: {
      timestamp: AT,
      complaintFeedbackType: "abuse",
      complainedRecipients: [{ emailAddress: "ada@example.com" }],
    },
  }),
  "email.failed": ses("Reject", { reject: { reason: "Bad content" } }),
  "email.opened": ses("Open", {
    open: { timestamp: AT, userAgent: "Mozilla/5.0", ipAddress: "198.51.100.1" },
  }),
  "email.clicked": ses("Click", {
    click: {
      timestamp: AT,
      link: "https://acme.test/o/1",
      userAgent: "Mozilla/5.0",
      ipAddress: "198.51.100.1",
    },
  }),
  "email.unsubscribed": ses("Subscription", {
    subscription: { timestamp: AT, contactList: "news", source: "header" },
  }),
}

const stalwart = (type: string, data: Record<string, unknown> = {}): StalwartEvent => ({
  id: "1",
  createdAt: AT,
  type,
  data: {
    from: `bounce+${MESSAGE_ID}@bounce.example.com`,
    to: "ada@example.com",
    queueId: "9",
    ...data,
  },
})

const STALWART_EVENTS: [string, StalwartEvent][] = [
  ["email.delivered", stalwart("delivery.delivered")],
  [
    "email.bounced",
    stalwart("delivery.rcpt-to-rejected", { code: 550, details: "user unknown" }),
  ],
  [
    "email.delivery_delayed",
    stalwart("queue.rescheduled", { nextRetry: "2026-10-05T12:10:00Z" }),
  ],
]

describe("the catalog covers every event, once", () => {
  it("has exactly one entry per event name, at version 1", () => {
    expect(WEBHOOK_EVENT_CATALOG.map((e) => e.type).sort()).toEqual(
      [...webhookEventName.options].sort(),
    )
    for (const e of WEBHOOK_EVENT_CATALOG) expect(e.version).toBe(1)
  })
})

describe("every SES payload matches its schema exactly", () => {
  it.each(Object.entries(SES_EVENTS) as [string, ReturnType<typeof ses>][])(
    "%s",
    (type, raw) => {
      const event = interpretSesEvent(raw, "sns-1")
      expect(event?.type).toBe(type as never)
      const parsed = webhookEventData[type as keyof typeof webhookEventData].safeParse(
        event!.data,
      )
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
      // And never an address or tag that is not the customer's.
      expect(JSON.stringify(event!.data)).not.toContain("203.0.113.9")
      expect(JSON.stringify(event!.data)).not.toContain("198.51.100.1")
      expect((event!.data as { tags: object }).tags).toEqual({ category: "receipt" })
    },
  )
})

describe("every Stalwart payload matches the same schema", () => {
  it.each(STALWART_EVENTS as never as [string, StalwartEvent][])(
    "%s",
    (type: string, raw: StalwartEvent) => {
      const event = interpretStalwartEvent(raw)
      expect(event?.type).toBe(type as never)
      const parsed = webhookEventData[type as keyof typeof webhookEventData].safeParse(
        event!.data,
      )
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
    },
  )

  // ⚠ THE SAME KEYS, WHICHEVER SERVER CARRIED IT. Values differ; the shape
  // a customer codes against does not.
  it.each(STALWART_EVENTS as never as [string, StalwartEvent][])(
    "%s has the same keys as SES's",
    (type: string, raw: StalwartEvent) => {
      // `tags` is the customer's own data: its keys are values, not shape.
      const keys = (o: unknown, name = ""): unknown =>
        name !== "tags" && o && typeof o === "object" && !Array.isArray(o)
          ? Object.fromEntries(
              Object.entries(o)
                .map(([k, v]) => [k, keys(v, k)])
                .sort(),
            )
          : null
      const fromSes = interpretSesEvent(SES_EVENTS[type]!, "sns-1")!.data
      const fromStalwart = interpretStalwartEvent(raw)!.data
      expect(keys(fromStalwart)).toEqual(keys(fromSes))
    },
  )
})

describe("examples and envelopes", () => {
  it.each(webhookEventName.options)("the %s example matches its schema", (type) => {
    const parsed = webhookEventData[type].safeParse(exampleData(type))
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
  })

  it.each(webhookEventName.options)(
    "a %s envelope matches the payload schema",
    (type) => {
      const body = envelope("0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60aa", {
        type,
        occurredAt: new Date(AT),
        data: exampleData(type),
        sequence: 3,
      })
      const parsed = webhookPayloadSchema(type).safeParse(body)
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
    },
  )

  it("refuses a payload with a field the catalog does not name", () => {
    const data = { ...exampleData("email.sent"), surprise: 1 }
    expect(webhookEventData["email.sent"].safeParse(data).success).toBe(false)
  })
})
