import { describe, expect, it, vi } from "vitest"
import { classifySesError, sesTransport } from "../src/send/ses.js"
import type { OutboundMessage } from "../src/send/transport.js"

const message: OutboundMessage = {
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
  tenantId: "ten-1",
  from: "hello@i10.tech",
  to: ["a@example.com"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hi",
  text: "body",
}

/** Captures the SendEmailCommand input without touching AWS. */
function client(behaviour: () => unknown = () => ({ MessageId: "ses-1" })) {
  // The parameter is unused: vi.fn records the call either way, and the
  // assertions read it back off `mock.calls`.
  const send = vi.fn(async () => {
    const out = behaviour()
    if (out instanceof Error) throw out
    return out
  })
  return { send } as never
}

const inputOf = (c: { send: { mock: { calls: [{ input: unknown }][] } } }) =>
  c.send.mock.calls[0]![0].input as Record<string, never>

describe("what reaches SES", () => {
  it("sends one message per call", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    expect(
      (c as unknown as { send: { mock: { calls: unknown[] } } }).send.mock.calls,
    ).toHaveLength(1)
  })

  // ⚠ THE JOIN KEY FOR EVERYTHING DOWNSTREAM. SES echoes this on every event,
  // and message_events is matched back to messages by it. Without it the
  // reconcilers cannot tell whose message an event describes.
  it("tags the message with i10's own id", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    expect(inputOf(c as never).EmailTags).toEqual([
      { Name: "i10_message_id", Value: message.id },
    ])
  })

  // SES allows only letters, digits, hyphens and underscores in a tag value, so
  // a bare UUID is fine and a prefixed `msg_…` id would be rejected at send.
  it("uses a tag value SES will accept", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    const value = (inputOf(c as never).EmailTags as unknown as { Value: string }[])[0]!
      .Value
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  // ⚠ Without a configuration set SES publishes no events, and the SES
  // reconciler reads exactly those events.
  it("passes the configuration set through when given one", async () => {
    const c = client()
    await sesTransport({ client: c, configurationSetName: "i10-prod" }).send(message)
    expect(inputOf(c as never).ConfigurationSetName).toBe("i10-prod")
  })

  // ⚠ The duplicate mitigation. A retry must reuse this exact header or the
  // accepted-duplicate rate becomes a delivered-duplicate rate.
  it("sets a Message-ID derived from our own id", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    const headers = inputOf(c as never).Content as unknown as {
      Simple: { Headers: { Name: string; Value: string }[] }
    }
    expect(headers.Simple.Headers).toContainEqual({
      Name: "Message-ID",
      Value: `<${message.id}@i10.tech>`,
    })
  })

  it("refuses to let a caller override the Message-ID", async () => {
    const c = client()
    await sesTransport({ client: c }).send({
      ...message,
      headers: { "message-id": "<forged@evil.test>" },
    })
    const headers = (
      inputOf(c as never).Content as unknown as {
        Simple: { Headers: { Name: string; Value: string }[] }
      }
    ).Simple.Headers
    expect(headers.filter((h) => h.Name.toLowerCase() === "message-id")).toHaveLength(1)
    expect(JSON.stringify(headers)).not.toContain("evil.test")
  })

  it("omits empty recipient lists rather than sending empty arrays", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    const dest = inputOf(c as never).Destination as unknown as Record<string, unknown>
    expect(dest.CcAddresses).toBeUndefined()
    expect(dest.BccAddresses).toBeUndefined()
  })
})

describe("the outcome", () => {
  it("reports the provider id on success", async () => {
    const result = await sesTransport({ client: client() }).send(message)
    expect(result).toEqual({ status: "sent", providerMessageId: "ses-1" })
  })

  // Recording it as sent would leave a message no event can join to; rejecting
  // it would drop mail SES may have taken.
  it("defers a 200 with no MessageId rather than guessing", async () => {
    const result = await sesTransport({ client: client(() => ({})) }).send(message)
    expect(result).toMatchObject({ status: "deferred" })
  })
})

describe("classifying SES failures", () => {
  const err = (name: string, httpStatusCode?: number) =>
    Object.assign(new Error(`${name} happened`), {
      name,
      $metadata: { httpStatusCode },
    })

  // ⚠ Retrying spends quota to reach the same answer and delays everything
  // behind it.
  it.each([
    "MessageRejected",
    "MailFromDomainNotVerifiedException",
    "BadRequestException",
    "NotFoundException",
    "AccountSuspendedException",
  ])("stops permanently on %s", (name) => {
    expect(classifySesError(err(name)).status).toBe("rejected")
  })

  // ⚠ Treating any of these as permanent drops mail the customer paid for.
  it.each([
    "SendingPausedException",
    "TooManyRequestsException",
    "LimitExceededException",
    "ThrottlingException",
  ])("retries %s", (name) => {
    expect(classifySesError(err(name)).status).toBe("deferred")
  })

  it("retries a 5xx", () => {
    expect(classifySesError(err("InternalServerError", 500)).status).toBe("deferred")
  })

  it("retries a 429 even when the name is unfamiliar", () => {
    expect(classifySesError(err("SomethingNew", 429)).status).toBe("deferred")
  })

  it("stops on an unfamiliar 4xx, which is usually the request being wrong", () => {
    expect(classifySesError(err("SomethingNew", 400)).status).toBe("rejected")
  })

  // ⚠ A socket failure is not evidence a message is undeliverable.
  it("retries a transport error with no status at all", () => {
    expect(classifySesError(new Error("ECONNRESET")).status).toBe("deferred")
  })

  it("keeps the reason, so last_error says something useful", () => {
    const outcome = classifySesError(err("MessageRejected"))
    expect(outcome.status === "rejected" && outcome.reason).toContain("MessageRejected")
  })
})
