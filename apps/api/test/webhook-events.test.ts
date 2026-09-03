import { describe, expect, it, vi } from "vitest"
import { enqueueDelivery } from "../src/queue/webhook-queue.js"
import { checkEndpointUrl } from "../src/webhooks/endpoints.js"
import {
  ingestSesEvent,
  interpretSesEvent,
  type EventOps,
} from "../src/webhooks/events.js"
import { canonicalString, isAwsUrl, verifySnsMessage } from "../src/webhooks/sns.js"

/**
 * Ingestion is the path where a forged request writes a permanent suppression,
 * so the tests that matter most here are the ones about refusing things.
 */

const mail = (over: Record<string, unknown> = {}) => ({
  messageId: "0100018e-ses",
  timestamp: "2026-09-03T10:00:00.000Z",
  source: "hello@i10.tech",
  destination: ["user@example.com"],
  tags: { i10_message_id: ["0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"] },
  commonHeaders: { subject: "Hi" },
  ...over,
})

describe("interpreting an SES notification", () => {
  it("maps the types we carry", () => {
    const cases: [string, string][] = [
      ["Send", "email.sent"],
      ["Delivery", "email.delivered"],
      ["Bounce", "email.bounced"],
      ["Complaint", "email.complained"],
      ["DeliveryDelay", "email.delivery_delayed"],
      ["Reject", "email.failed"],
    ]
    for (const [ses, ours] of cases) {
      expect(interpretSesEvent({ eventType: ses, mail: mail() }, "sns-1")?.type).toBe(
        ours,
      )
    }
  })

  // ⚠ IGNORED, NOT AN ERROR. Someone turning on Open tracking in the SES console
  // would otherwise make this endpoint 500 on every notification, and SNS would
  // retry each one for hours.
  it("ignores a type we do not carry", () => {
    expect(interpretSesEvent({ eventType: "Open", mail: mail() }, "sns-1")).toBeNull()
  })

  // ⚠ SES RENDERS TAG VALUES AS ARRAYS. Reading it as a string yields undefined
  // and every event silently fails to match a message.
  it("reads the message id out of the tag array", () => {
    const event = interpretSesEvent({ eventType: "Send", mail: mail() }, "sns-1")
    expect(event?.messageId).toBe("0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071")
  })

  it("ignores an event with no i10 tag", () => {
    const untagged = { eventType: "Send", mail: mail({ tags: {} }) }
    expect(interpretSesEvent(untagged, "sns-1")).toBeNull()
  })

  // ⚠ SES SPELLS IT WITH A SPACE IN THE PAYLOAD; `RENDERING_FAILURE` is the
  // configuration-set API's spelling. Missing it is silent — a template that
  // failed to render would read as `sent` forever.
  it.each(["Rendering Failure", "RENDERING_FAILURE"])(
    "maps %s to email.failed",
    (eventType) => {
      expect(interpretSesEvent({ eventType, mail: mail() }, "sns-1")?.type).toBe(
        "email.failed",
      )
    },
  )

  // ⚠ THE DEDUPE KEY HAS TO SURVIVE A REDELIVERY. `new Date()` here would let a
  // notification with no usable timestamp be recorded twice — two delivery rows
  // and two customer webhooks for one real event.
  it("falls back to a caller-supplied clock, not to now", () => {
    const snsAt = new Date("2026-09-03T09:00:00.000Z")
    const undated = { eventType: "Send", mail: mail({ timestamp: undefined }) }

    const first = interpretSesEvent(undated, "sns-1", snsAt)
    const second = interpretSesEvent(undated, "sns-1", snsAt)

    expect(first?.occurredAt).toEqual(snsAt)
    expect(first?.occurredAt).toEqual(second?.occurredAt)
  })

  it("uses SNS's message id as the dedupe key", () => {
    const event = interpretSesEvent({ eventType: "Send", mail: mail() }, "sns-42")
    expect(event?.sourceEventId).toBe("sns-42")
  })
})

describe("suppression", () => {
  const bounce = (bounceType: string) => ({
    eventType: "Bounce",
    mail: mail(),
    bounce: {
      bounceType,
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "Gone@Example.COM" }],
      timestamp: "2026-09-03T10:00:01.000Z",
    },
  })

  it("suppresses a permanent bounce", () => {
    const event = interpretSesEvent(bounce("Permanent"), "sns-1")
    expect(event?.suppress).toEqual([
      { address: "gone@example.com", reason: "hard_bounce" },
    ])
  })

  // ⚠ THE ONE THAT LOSES REAL MAIL IF IT REGRESSES. A full mailbox or a
  // greylisting arrives as `Bounce` and recovers on its own; suppressing on it
  // stops a customer's mail to someone who did nothing wrong, permanently, and
  // they never find out why.
  it.each(["Transient", "Undetermined"])("does not suppress a %s bounce", (type) => {
    expect(interpretSesEvent(bounce(type), "sns-1")?.suppress).toEqual([])
  })

  it("suppresses a complaint", () => {
    const event = interpretSesEvent(
      {
        eventType: "Complaint",
        mail: mail(),
        complaint: {
          complainedRecipients: [{ emailAddress: "angry@example.com" }],
          complaintFeedbackType: "abuse",
        },
      },
      "sns-1",
    )
    expect(event?.suppress).toEqual([
      { address: "angry@example.com", reason: "complaint" },
    ])
  })
})

describe("the payload a customer receives", () => {
  // ⚠ NOT SES'S SHAPE. Forwarding it verbatim would make AWS's schema our
  // public API, and changing relay would then break every customer.
  it("does not leak SES's own field names", () => {
    const event = interpretSesEvent(
      {
        eventType: "Bounce",
        mail: mail(),
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "NoEmail",
          bouncedRecipients: [{ emailAddress: "gone@example.com" }],
        },
      },
      "sns-1",
    )

    expect(event?.data).toMatchObject({
      email_id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
      bounce: { type: "permanent", subtype: "noemail" },
    })
    expect(JSON.stringify(event?.data)).not.toContain("bouncedRecipients")
  })
})

describe("ingestion", () => {
  function ops(over: Partial<EventOps> = {}) {
    const record = vi.fn(async () => ({
      status: "recorded" as const,
      deliveries: [
        { id: "wh-1", endpointId: "ep-1", tenantId: "ten-1", occurredAt: new Date() },
      ],
    }))
    const enqueue = vi.fn(async () => {})
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    return {
      deps: {
        ownerOf: async () => ({ tenantId: "ten-1", createdAt: new Date() }),
        record,
        enqueue,
        log,
        ...over,
      } as EventOps & { log: typeof log },
      record,
      enqueue,
      log,
    }
  }

  const notification = { eventType: "Delivery", mail: mail(), delivery: {} }

  it("records and queues", async () => {
    const { deps, enqueue } = ops()
    const outcome = await ingestSesEvent(notification, "sns-1", deps)
    expect(outcome).toEqual({ status: "recorded", queued: 1 })
    expect(enqueue).toHaveBeenCalledOnce()
  })

  // ⚠ COMMIT THEN ENQUEUE, NEVER THE OTHER WAY. A job whose delivery row is not
  // committed finds nothing and is dropped, and the customer's webhook is lost
  // with no error anywhere.
  it("records before it queues", async () => {
    const order: string[] = []
    const { deps } = ops({
      record: async () => {
        order.push("record")
        return {
          status: "recorded",
          deliveries: [
            {
              id: "wh-1",
              endpointId: "ep-1",
              tenantId: "ten-1",
              occurredAt: new Date(),
            },
          ],
        }
      },
      enqueue: async () => {
        order.push("enqueue")
      },
    })
    await ingestSesEvent(notification, "sns-1", deps)
    expect(order).toEqual(["record", "enqueue"])
  })

  it("queues nothing for a duplicate notification", async () => {
    const { deps, enqueue } = ops({ record: async () => ({ status: "duplicate" }) })
    expect(await ingestSesEvent(notification, "sns-1", deps)).toEqual({
      status: "duplicate",
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  // ⚠ NOT AN ERROR AND NOT A RETRY. The likeliest cause is retention dropping
  // the partition a months-old message lived in; a non-2xx would make SNS retry
  // for hours over a message that no longer exists.
  it("reports an unknown message without failing", async () => {
    const { deps, record } = ops({ ownerOf: async () => null })
    expect(await ingestSesEvent(notification, "sns-1", deps)).toEqual({
      status: "unknown_message",
    })
    expect(record).not.toHaveBeenCalled()
  })

  // The rows are committed and queryable; reporting a failure would make SNS
  // redeliver, and the unique index would then discard the event — losing the
  // webhook in order to fix the queue.
  it("still succeeds when the enqueue fails after commit", async () => {
    const { deps, log } = ops({
      enqueue: async () => {
        throw new Error("redis down")
      },
    })
    expect((await ingestSesEvent(notification, "sns-1", deps)).status).toBe("recorded")
    expect(log.error).toHaveBeenCalled()
  })
})

describe("delivery ordering", () => {
  // ⚠ THE ORDERING THE QUEUE PROMISES IS ONLY REAL IF THE EVENT'S OWN CLOCK IS
  // WHAT ORDERS IT. SES publishes `Send` and `Delivery` milliseconds apart and
  // SNS fans them out as two concurrent requests; ordering on arrival lets a
  // customer see `email.delivered` before `email.sent`.
  it("enqueues on the event's clock, not on arrival", async () => {
    const add = vi.fn(async () => ({ id: "j" }))
    const occurredAt = new Date("2026-09-03T09:00:00Z")

    await enqueueDelivery(
      { add } as never,
      { deliveryId: "wh-1", endpointId: "ep-1", tenantId: "ten-1" },
      { orderMs: occurredAt.getTime() },
    )

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "ep-1", orderMs: occurredAt.getTime() }),
    )
  })
})

describe("SNS message verification", () => {
  // ⚠ THE HOST ALLOWLIST IS THE WHOLE SSRF DEFENCE. The certificate URL arrives
  // inside the message being verified, so fetching it before checking the host
  // lets an attacker serve their own certificate and sign whatever they like.
  it("accepts only Amazon's own hosts over https", () => {
    expect(isAwsUrl("https://sns.eu-central-1.amazonaws.com/cert.pem")).toBe(true)
    expect(isAwsUrl("https://sns.cn-north-1.amazonaws.com.cn/cert.pem")).toBe(true)
  })

  it.each([
    // The classic `endsWith` bypass.
    "https://sns.eu-central-1.amazonaws.com.evil.test/cert.pem",
    "http://sns.eu-central-1.amazonaws.com/cert.pem",
    "https://evil.test/cert.pem",
    "https://sns.eu-central-1.amazonaws.com@evil.test/cert.pem",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isAwsUrl(url)).toBe(false)
  })

  it("refuses before it fetches anything", async () => {
    const fetchCertificate = vi.fn(async () => "")
    const verdict = await verifySnsMessage(
      {
        Type: "Notification",
        MessageId: "m",
        TopicArn: "t",
        Message: "{}",
        Timestamp: "2026-09-03T10:00:00.000Z",
        SignatureVersion: "1",
        Signature: "x",
        SigningCertURL: "https://evil.test/cert.pem",
      },
      fetchCertificate,
    )
    expect(verdict).toMatchObject({ ok: false })
    expect(fetchCertificate).not.toHaveBeenCalled()
  })

  it("refuses a signature version it does not know", async () => {
    const verdict = await verifySnsMessage(
      {
        Type: "Notification",
        MessageId: "m",
        TopicArn: "t",
        Message: "{}",
        Timestamp: "2026-09-03T10:00:00.000Z",
        SignatureVersion: "9",
        Signature: "x",
        SigningCertURL: "https://sns.eu-central-1.amazonaws.com/cert.pem",
      },
      async () => "",
    )
    expect(verdict).toMatchObject({ ok: false })
  })

  // ⚠ AN ABSENT OPTIONAL FIELD IS SKIPPED, NOT WRITTEN EMPTY. Including
  // `Subject` as an empty string produces a string Amazon never signed, and
  // every notification without a subject would be rejected.
  it("omits absent fields from the canonical string", () => {
    const built = canonicalString(
      {
        Type: "Notification",
        MessageId: "m",
        TopicArn: "t",
        Message: "body",
        Timestamp: "ts",
        SignatureVersion: "1",
        Signature: "sig",
        SigningCertURL: "url",
      },
      ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
    )
    expect(built).toBe(
      "Message\nbody\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n",
    )
    expect(built).not.toContain("Subject")
  })
})

describe("endpoint URLs", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(checkEndpointUrl("https://hooks.example.com/i10")).toEqual({ ok: true })
  })

  // ⚠ EVERY ONE OF THESE IS REACHABLE FROM THE WORKER AND NOT FROM THE
  // CUSTOMER. Registering one turns our delivery machinery into a probe of the
  // cluster's own network.
  it.each([
    ["http://hooks.example.com/i10", "plain http"],
    ["https://localhost/i10", "localhost"],
    ["https://169.254.169.254/latest/meta-data/", "the metadata address"],
    ["https://10.0.0.1/i10", "a private range"],
    ["https://i10-platform-db.i10-prod.svc/i10", "a cluster service"],
    ["https://redis.internal/i10", "an internal suffix"],
    ["https://intranet/i10", "a single label"],
    ["https://user:pass@hooks.example.com/i10", "embedded credentials"],
    ["https://[::1]/i10", "an IPv6 literal"],
  ])("refuses %s (%s)", (url) => {
    expect(checkEndpointUrl(url).ok).toBe(false)
  })
})
