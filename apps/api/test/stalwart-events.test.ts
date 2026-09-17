import { createHmac } from "node:crypto"
import { describe, expect, it, mock } from "bun:test"
import { createStalwartWebhooks } from "../src/routes/stalwart-events.js"
import type { EventOps } from "../src/webhooks/events.js"
import { decodeSecret } from "../src/webhooks/signing.js"
import {
  interpretStalwartEvent,
  messageIdFrom,
  sourceEventIdFor,
  verifyStalwartSignature,
  type StalwartEvent,
} from "../src/webhooks/stalwart.js"

/**
 * The direct route's delivery events.
 *
 * ⚠ THE SHAPES HERE ARE READ OUT OF STALWART'S SOURCE, NOT GUESSED. `data`
 * carries the event's own keys merged with its SPAN's keys — the collector
 * attaches the open `delivery.attempt-start` span to every event sharing its
 * span id, and the webhook serializer is built `.with_spans()`. That is why
 * `from` (the VERP envelope, and our only join key) appears on an event that
 * does not set it. Fixtures that omitted it would pass against an interpreter
 * that could never work.
 */

const MESSAGE_ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const SECRET = "a-shared-key-for-testing"

/** An outcome event as Stalwart serialises one, span keys merged in. */
const event = (
  type: string,
  data: Record<string, unknown> = {},
  over: Partial<StalwartEvent> = {},
): StalwartEvent => ({
  // ⚠ THE PROCESS COUNTER IS IN HERE, WHICH IS THE POINT OF THE DEDUPE TEST.
  id: "17579800000001234",
  createdAt: "2026-09-17T10:00:00Z",
  type,
  data: {
    // From the span: `delivery.attempt-start` sets `From = return_path`.
    from: `bounce+${MESSAGE_ID}@bounce.example.com`,
    queueId: "9876543210",
    queueName: "default",
    spanId: "4242",
    ...data,
  },
  ...over,
})

describe("verifying a Stalwart notification", () => {
  const sign = (body: string, key = SECRET) =>
    createHmac("sha256", key).update(body, "utf8").digest("base64")

  /**
   * ⚠ THE KEY IS THE SECRET'S OWN BYTES. Every other signature in this
   * repository base64-decodes the secret first, because that is what Svix's
   * scheme requires and `signing.ts` warns at length about getting it wrong.
   * Stalwart does `hmac::Key::new(HMAC_SHA256, settings.key.as_bytes())` over
   * the configured string, so following this codebase's own habit here would
   * reject every genuine notification.
   */
  it("accepts a signature over the raw body, keyed by the secret itself", () => {
    const body = '{"events":[]}'
    expect(verifyStalwartSignature(body, sign(body), SECRET)).toBe(true)
  })

  /**
   * ⚠ THE GUARD AGAINST A PLAUSIBLE "FIX". `decodeSecret` is what every other
   * verifier in this repository uses, and `signing.ts` warns at length that
   * keying with the printable form is the mistake that looks correct from
   * inside this codebase. Here it is the other way round, so someone tidying
   * this file into line with its neighbours would break it — and the symptom is
   * a 403 on a signature that is demonstrably right, which sends you looking at
   * Stalwart rather than at the key.
   */
  it("does not key the HMAC with the decoded secret, unlike every other verifier here", () => {
    const body = '{"events":[]}'
    const svixStyle = createHmac("sha256", decodeSecret(SECRET))
      .update(body, "utf8")
      .digest("base64")

    expect(verifyStalwartSignature(body, svixStyle, SECRET)).toBe(false)
  })

  it("refuses a tampered body", () => {
    const signature = sign('{"events":[]}')
    expect(verifyStalwartSignature('{"events":[{}]}', signature, SECRET)).toBe(false)
  })

  it("refuses the wrong key", () => {
    const body = '{"events":[]}'
    expect(verifyStalwartSignature(body, sign(body, "not-the-key"), SECRET)).toBe(false)
  })

  // ⚠ ABSENT IS NOT VALID. A missing header must be a refusal rather than
  // reaching a comparison that happens to fail.
  it("refuses a missing or unparseable header", () => {
    const body = '{"events":[]}'
    expect(verifyStalwartSignature(body, undefined, SECRET)).toBe(false)
    expect(verifyStalwartSignature(body, "", SECRET)).toBe(false)
    // Base64 of the wrong length: `timingSafeEqual` throws on a mismatch, so the
    // length guard is what stops this being a 500 anyone can trigger.
    expect(verifyStalwartSignature(body, "c2hvcnQ=", SECRET)).toBe(false)
  })
})

describe("finding the message a Stalwart event is about", () => {
  /**
   * ⚠ THE VERP ENVELOPE IS THE ONLY JOIN KEY, and it arrives from the span
   * rather than from the outcome event. `delivery.delivered` sets only spanId,
   * hostname, to, code, details and elapsed.
   */
  it("reads our id out of the VERP envelope sender", () => {
    expect(messageIdFrom(`bounce+${MESSAGE_ID}@bounce.example.com`)).toBe(MESSAGE_ID)
  })

  it("is case-insensitive and normalises", () => {
    expect(messageIdFrom(`bounce+${MESSAGE_ID.toUpperCase()}@bounce.EXAMPLE.com`)).toBe(
      MESSAGE_ID,
    )
  })

  /**
   * ⚠ STALWART'S QUEUE CARRIES MAIL THAT IS NOT OURS. Human mailbox mail, its
   * own DSNs and its own DMARC/TLS reports all leave through the same outbound
   * path and none has a VERP envelope. Those events must be ignored rather than
   * matched to something.
   */
  it("returns null for mail that is not a transactional send", () => {
    expect(messageIdFrom("mohamed@i10.tech")).toBeNull()
    expect(messageIdFrom("<>")).toBeNull()
    expect(messageIdFrom("bounce+not-a-uuid@bounce.example.com")).toBeNull()
    expect(messageIdFrom(undefined)).toBeNull()
    expect(messageIdFrom(42)).toBeNull()
  })

  it("ignores an event with no envelope sender at all", () => {
    expect(
      interpretStalwartEvent(event("delivery.delivered", { from: null })),
    ).toBeNull()
  })
})

describe("interpreting a Stalwart event", () => {
  it("maps the types we carry", () => {
    const cases: [
      string,
      NonNullable<ReturnType<typeof interpretStalwartEvent>>["type"],
    ][] = [
      ["delivery.delivered", "email.delivered"],
      ["delivery.rcpt-to-rejected", "email.bounced"],
      ["delivery.message-rejected", "email.bounced"],
      ["delivery.failed", "email.bounced"],
      ["queue.rescheduled", "email.delivery_delayed"],
    ]
    for (const [stalwart, ours] of cases) {
      expect(interpretStalwartEvent(event(stalwart))?.type).toBe(ours)
    }
  })

  /**
   * ⚠ IGNORED, NOT AN ERROR, for the same reason the SES ingest ignores `Open`.
   * Stalwart emits hundreds of events and somebody will widen the include list
   * in the admin UI to see what happens. That must not make this endpoint fail
   * every batch.
   */
  it("ignores an event type we do not carry", () => {
    expect(interpretStalwartEvent(event("delivery.mx-lookup"))).toBeNull()
    expect(interpretStalwartEvent(event("auth.success"))).toBeNull()
    expect(interpretStalwartEvent({ type: undefined, data: {} })).toBeNull()
  })

  it("takes the recipient from the event and not from the span", () => {
    // The span lists every recipient in the attempt; the outcome event names
    // the one it is about, and the serializer lets the event's key win.
    const one = interpretStalwartEvent(
      event("delivery.delivered", { to: "someone@elsewhere.test" }),
    )
    expect(one?.data["to"]).toEqual(["someone@elsewhere.test"])
  })

  /**
   * ⚠ `to` IS A LIST ON THE EVENTS THAT INHERIT IT FROM THE SPAN.
   * `delivery.message-rejected` sets no recipient of its own — the receiver
   * refused the message, not an address — so the span's list is what arrives.
   */
  it("reads a recipient list as well as a single recipient", () => {
    const many = interpretStalwartEvent(
      event("delivery.message-rejected", {
        to: ["a@elsewhere.test", "b@elsewhere.test"],
        code: 552,
      }),
    )
    expect(many?.data["to"]).toEqual(["a@elsewhere.test", "b@elsewhere.test"])
  })

  it("uses the event's own timestamp", () => {
    const at = interpretStalwartEvent(
      event("delivery.delivered", {}, { createdAt: "2026-09-17T11:22:33Z" }),
    )?.occurredAt
    expect(at?.toISOString()).toBe("2026-09-17T11:22:33.000Z")
  })

  // A malformed timestamp must still produce a value stable across redeliveries.
  it("falls back to the caller's clock on an unusable timestamp", () => {
    const fallback = new Date("2026-01-01T00:00:00Z")
    const at = interpretStalwartEvent(
      event("delivery.delivered", {}, { createdAt: "not a date" }),
      fallback,
    )?.occurredAt
    expect(at).toEqual(fallback)
  })
})

/**
 * ⚠ THE BUG THIS PREVENTS IS A SECOND BOUNCE FOR ONE FAILURE. Stalwart's event
 * `id` is `{timestamp}{counter}{typeId}`, and the counter is a PROCESS-GLOBAL
 * ATOMIC INCREMENTED WHEN THE BATCH IS SERIALISED — not a property of the event.
 * A failed POST puts the same events back on the pending list, and the next
 * batch serialises them again with fresh counter values. Keying the dedupe on
 * that id would turn every retry into a second `email.bounced`, a second
 * suppression and a second customer webhook.
 */
describe("the dedupe key", () => {
  it("is identical when the same event is redelivered under a new id", () => {
    const first = event("delivery.failed", { to: "x@elsewhere.test" }, { id: "111" })
    const retry = event("delivery.failed", { to: "x@elsewhere.test" }, { id: "999" })

    expect(sourceEventIdFor(first)).toBe(sourceEventIdFor(retry))
    expect(interpretStalwartEvent(first)?.sourceEventId).toBe(
      interpretStalwartEvent(retry)?.sourceEventId,
    )
  })

  // A real second attempt is a different event and must not be collapsed.
  it("differs for a later attempt to the same recipient", () => {
    const first = event(
      "delivery.failed",
      { to: "x@elsewhere.test" },
      { createdAt: "2026-09-17T10:00:00Z" },
    )
    const later = event(
      "delivery.failed",
      { to: "x@elsewhere.test" },
      { createdAt: "2026-09-17T11:00:00Z" },
    )
    expect(sourceEventIdFor(first)).not.toBe(sourceEventIdFor(later))
  })

  it("differs per recipient and per outcome", () => {
    const a = event("delivery.delivered", { to: "a@elsewhere.test" })
    const b = event("delivery.delivered", { to: "b@elsewhere.test" })
    const c = event("delivery.failed", { to: "a@elsewhere.test" })
    expect(new Set([a, b, c].map(sourceEventIdFor)).size).toBe(3)
  })

  /**
   * ⚠ THE COLUMN IS SHARED WITH SNS. `source_event_id` holds Amazon's message
   * ids too, and an unprefixed hash could in principle collide with one — which
   * would silently discard a real event as a duplicate.
   */
  it("is namespaced so it cannot collide with an SNS message id", () => {
    expect(sourceEventIdFor(event("delivery.delivered"))).toMatch(
      /^stalwart_[0-9a-f]+$/,
    )
  })
})

/**
 * ⚠ A SUPPRESSION IS PERMANENT AND SILENT FROM THE CUSTOMER'S SIDE, so the bar
 * for writing one is evidence about the ADDRESS — not about the message, and
 * not about the receiver having a bad week.
 */
describe("what suppresses an address", () => {
  it("suppresses on a 5xx refusal of the recipient", () => {
    const bounced = interpretStalwartEvent(
      event("delivery.rcpt-to-rejected", { to: "gone@elsewhere.test", code: 550 }),
    )
    expect(bounced?.suppress).toEqual([
      { address: "gone@elsewhere.test", reason: "hard_bounce" },
    ])
    expect(bounced?.data["bounce"]).toMatchObject({ type: "permanent" })
  })

  /**
   * ⚠ A 4xx IS "COME BACK LATER", AND SUPPRESSING ON IT STOPS A CUSTOMER'S MAIL
   * TO SOMEBODY WHOSE MAILBOX WORKS. A full mailbox and a greylisting both
   * arrive here.
   */
  it("does not suppress on a 4xx refusal", () => {
    const deferred = interpretStalwartEvent(
      event("delivery.rcpt-to-rejected", { to: "busy@elsewhere.test", code: 452 }),
    )
    expect(deferred?.suppress).toEqual([])
    expect(deferred?.data["bounce"]).toMatchObject({ type: "transient" })
  })

  /**
   * ⚠ `delivery.failed` IS THE RETRY WINDOW EXPIRING. The receiver was
   * unreachable for days, which says nothing about whether the address exists.
   */
  it("does not suppress when we simply gave up", () => {
    const expired = interpretStalwartEvent(
      event("delivery.failed", { to: "unreachable@elsewhere.test" }),
    )
    expect(expired?.type).toBe("email.bounced")
    expect(expired?.suppress).toEqual([])
    expect(expired?.data["bounce"]).toMatchObject({ type: "transient" })
  })

  /** The receiver refused the MESSAGE. The recipient is fine. */
  it("does not suppress when the message itself was rejected", () => {
    const rejected = interpretStalwartEvent(
      event("delivery.message-rejected", { to: "fine@elsewhere.test", code: 552 }),
    )
    expect(rejected?.type).toBe("email.bounced")
    expect(rejected?.suppress).toEqual([])
  })

  it("does not suppress without a reply code to read", () => {
    const vague = interpretStalwartEvent(
      event("delivery.rcpt-to-rejected", { to: "x@elsewhere.test" }),
    )
    expect(vague?.suppress).toEqual([])
    expect(vague?.data["bounce"]).toMatchObject({ type: "undetermined" })
  })
})

/**
 * ⚠ THE CUSTOMER MUST NOT BE ABLE TO TELL WHICH MTA CARRIED THE MESSAGE. That
 * is the whole promise of the per-domain route lever, and a webhook payload is
 * where it would leak first.
 */
describe("what the customer receives", () => {
  it("matches the SES path's envelope fields", () => {
    const delivered = interpretStalwartEvent(
      event("delivery.delivered", { to: "someone@elsewhere.test" }),
    )
    expect(delivered?.data).toMatchObject({
      email_id: MESSAGE_ID,
      to: ["someone@elsewhere.test"],
      created_at: "2026-09-17T10:00:00.000Z",
    })
  })

  /**
   * ⚠ `from` IS NULL RATHER THAN THE ENVELOPE. Stalwart reports the return
   * path, which is our VERP bounce address — not the customer's `From:` header.
   * Echoing it into a field a customer reads as the sender would be worse than
   * omitting it.
   */
  it("never reports the VERP envelope as the sender", () => {
    const delivered = interpretStalwartEvent(event("delivery.delivered"))
    expect(delivered?.data["from"]).toBeNull()
    expect(JSON.stringify(delivered?.data)).not.toContain("bounce+")
  })
})

/** A minimal EventOps that records what it was asked to write. */
function ops() {
  const recorded: { messageId: string; type: string }[] = []
  return {
    recorded,
    ownerOf: mock(async () => ({ tenantId: "ten-1", createdAt: new Date() })),
    record: mock(
      async ({ event: e }: { event: { messageId: string; type: string } }) => {
        recorded.push({ messageId: e.messageId, type: e.type })
        return { status: "recorded" as const, deliveries: [] }
      },
    ),
    enqueue: mock(async () => {}),
  } as unknown as EventOps & { recorded: { messageId: string; type: string }[] }
}

const log = { info: () => {}, warn: () => {}, error: () => {} }

describe("the ingest endpoint", () => {
  const post = (
    app: ReturnType<typeof createStalwartWebhooks>,
    body: string,
    sig?: string,
  ) =>
    app.request("/stalwart", {
      method: "POST",
      headers: sig === undefined ? {} : { "X-Signature": sig },
      body,
    })

  const sign = (body: string) =>
    createHmac("sha256", SECRET).update(body, "utf8").digest("base64")

  /**
   * ⚠ NOTHING REACHES THE DATABASE BEFORE THE HMAC VERIFIES. A forged
   * `delivery.rcpt-to-rejected` with a 5xx suppresses an address for a tenant,
   * permanently and silently.
   */
  it("answers 403 and writes nothing when the signature is wrong", async () => {
    const events = ops()
    const app = createStalwartWebhooks({ events, log, secret: SECRET })
    const body = JSON.stringify({
      events: [event("delivery.rcpt-to-rejected", { to: "v@x.test", code: 550 })],
    })

    const res = await post(app, body, "AAAA")

    expect(res.status).toBe(403)
    expect(events.recorded).toEqual([])
  })

  it("answers 403 when the signature header is absent entirely", async () => {
    const events = ops()
    const app = createStalwartWebhooks({ events, log, secret: SECRET })
    const res = await post(app, JSON.stringify({ events: [] }))
    expect(res.status).toBe(403)
    expect(events.recorded).toEqual([])
  })

  it("records a signed batch", async () => {
    const events = ops()
    const app = createStalwartWebhooks({ events, log, secret: SECRET })
    const body = JSON.stringify({
      events: [
        event("delivery.delivered", { to: "a@x.test" }),
        event("delivery.failed", { to: "b@x.test" }),
      ],
    })

    const res = await post(app, body, sign(body))

    expect(res.status).toBe(200)
    expect(events.recorded).toEqual([
      { messageId: MESSAGE_ID, type: "email.delivered" },
      { messageId: MESSAGE_ID, type: "email.bounced" },
    ])
  })

  /**
   * ⚠ ONE BATCH CARRIES EVENTS FOR MAIL THAT IS NOT OURS. Stalwart groups
   * everything inside its throttle window, so mailbox mail and our transactional
   * sends arrive together. The ones without a VERP envelope are skipped, and the
   * batch still succeeds.
   */
  it("skips events for mail that is not ours without failing the batch", async () => {
    const events = ops()
    const app = createStalwartWebhooks({ events, log, secret: SECRET })
    const body = JSON.stringify({
      events: [
        event("delivery.delivered", { from: "mohamed@i10.tech", to: "a@x.test" }),
        event("delivery.mx-lookup"),
        event("delivery.delivered", { to: "b@x.test" }),
      ],
    })

    const res = await post(app, body, sign(body))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ recorded: 1, ignored: 2 })
    expect(events.recorded).toEqual([
      { messageId: MESSAGE_ID, type: "email.delivered" },
    ])
  })

  /**
   * ⚠ 500 SO STALWART REDELIVERS. Losing a bounce means an address we keep
   * sending to, and the dedupe makes the replay of the already-written half
   * harmless.
   */
  it("answers 500 when a write fails", async () => {
    const events = {
      ownerOf: async () => ({ tenantId: "ten-1", createdAt: new Date() }),
      record: async () => {
        throw new Error("deadlock detected")
      },
      enqueue: async () => {},
    } as unknown as EventOps
    const app = createStalwartWebhooks({ events, log, secret: SECRET })
    const body = JSON.stringify({ events: [event("delivery.delivered")] })

    expect((await post(app, body, sign(body))).status).toBe(500)
  })

  // Signed with our key and still unparseable: a version change, not an attack.
  // Retrying cannot fix it, so take it off the queue.
  it("answers 200 to a signed body that is not an object", async () => {
    const events = ops()
    const app = createStalwartWebhooks({ events, log, secret: SECRET })
    for (const body of ["null", "[]", "not json"]) {
      expect((await post(app, body, sign(body))).status).toBe(200)
    }
    expect(events.recorded).toEqual([])
  })

  /**
   * ⚠ 503 RATHER THAN ACCEPTING UNSIGNED NOTIFICATIONS. A public endpoint that
   * writes suppressions must never be reachable without a signature, not even in
   * a half-configured environment.
   */
  it("answers 503 when no secret is configured", async () => {
    const app = createStalwartWebhooks()
    const res = await app.request("/stalwart", { method: "POST", body: "{}" })
    expect(res.status).toBe(503)
  })
})
