import { describe, expect, it, mock } from "bun:test"
import { feedbackTokens } from "../src/send/feedback-id.js"
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
  // The parameter is unused: mock records the call either way, and the
  // assertions read it back off `mock.calls`.
  const send = mock(async () => {
    const out = behaviour()
    if (out instanceof Error) throw out
    return out
  })
  return { send } as never
}

// ⚠ `unknown`, NOT `never`, AS THE VALUE TYPE. `Record<string, never>` made
// every field of the SES input `never`, which vitest's `toEqual(expected: any)`
// never noticed. bun types the matcher against the RECEIVED value, so a
// `never` field accepts no expectation at all and every assertion below became
// "not assignable to parameter of type 'undefined'". The cast was always a lie;
// this is the honest version of it.
const inputOf = (c: { send: { mock: { calls: [{ input: unknown }][] } } }) =>
  c.send.mock.calls[0]![0].input as Record<string, unknown>

/** The message as it actually goes on the wire, now that every send is raw. */
const rawOf = (c: { send: { mock: { calls: [{ input: unknown }][] } } }) =>
  Buffer.from(
    (inputOf(c).Content as unknown as { Raw: { Data: Uint8Array } }).Raw.Data,
  ).toString("utf8")

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

  // ⚠ #156. A tenant is named only when the message carries one - the worker
  // sets it only once the identity is recorded as attached, because SES refuses
  // a tenant send whose identity or configuration set it does not associate.
  it("names the SES tenant when the message carries one", async () => {
    const c = client()
    await sesTransport({ client: c }).send({ ...message, sesTenant: "i10-ten" })
    expect(inputOf(c as never).TenantName).toBe("i10-ten")
  })

  // #154: the domain's tracking picks the set; the base name is only a prefix.
  it("sends a tracked domain's mail through the tracking set", async () => {
    const c = client()
    await sesTransport({ client: c, configurationSetName: "i10-events" }).send({
      ...message,
      tracking: { opens: true, clicks: true },
    })
    expect(inputOf(c as never).ConfigurationSetName).toBe("i10-events-tracked")
  })

  it("sends untracked mail through the base set", async () => {
    const c = client()
    await sesTransport({ client: c, configurationSetName: "i10-events" }).send({
      ...message,
      tracking: null,
    })
    expect(inputOf(c as never).ConfigurationSetName).toBe("i10-events")
  })

  it("names no tenant when the message carries none", async () => {
    const c = client()
    await sesTransport({ client: c }).send({ ...message, sesTenant: null })
    expect(inputOf(c as never).TenantName).toBeUndefined()
  })

  // ⚠ The duplicate mitigation. A retry must reuse this exact header or the
  // accepted-duplicate rate becomes a delivered-duplicate rate.
  //
  // ⚠ AND IT IS READ OUT OF THE RAW BYTES, WHICH IS THE WHOLE POINT. This used
  // to assert `Content.Simple.Headers`, and passed, while SES refused every
  // such send with `Header <Message-ID> is not supported` - the header is
  // reserved there and can only travel in raw MIME.
  it("sets a Message-ID derived from our own id", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    expect(rawOf(c)).toContain(`Message-ID: <${message.id}@i10.tech>`)
  })

  it("refuses to let a caller override the Message-ID", async () => {
    const c = client()
    await sesTransport({ client: c }).send({
      ...message,
      headers: { "message-id": "<forged@evil.test>" },
    })
    const raw = rawOf(c)
    expect(raw.match(/^Message-ID:/gim) ?? []).toHaveLength(1)
    expect(raw).not.toContain("evil.test")
  })

  it("omits empty recipient lists rather than sending empty arrays", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    const dest = inputOf(c as never).Destination as unknown as Record<string, unknown>
    expect(dest.CcAddresses).toBeUndefined()
    expect(dest.BccAddresses).toBeUndefined()
  })
})

describe("tags", () => {
  // ⚠ OURS CANNOT BE OVERWRITTEN. `i10_message_id` matches an event back to the
  // message it describes; a customer tag of the same name would detach every
  // bounce and complaint for that send from the row that explains it - and
  // suppression, built from those events, would stop working for it.
  it("keeps i10's tag ahead of the caller's and refuses a collision", async () => {
    const c = client()
    await sesTransport({ client: c }).send({
      ...message,
      tags: [
        { name: "campaign", value: "spring" },
        { name: "i10_message_id", value: "hijacked" },
      ],
    })

    expect(inputOf(c).EmailTags).toEqual([
      { Name: "i10_message_id", Value: message.id },
      { Name: "campaign", Value: "spring" },
    ])
  })

  it("forwards the caller's tags", async () => {
    const c = client()
    await sesTransport({ client: c }).send({
      ...message,
      tags: [{ name: "campaign", value: "spring" }],
    })
    expect(inputOf(c).EmailTags).toContainEqual({ Name: "campaign", Value: "spring" })
  })
})

describe("the Feedback-ID", () => {
  const SECRET = "a-test-secret-that-is-at-least-32-bytes-long"
  const feedbackToken = feedbackTokens(SECRET)
  const tagsOf = (c: Parameters<typeof inputOf>[0]) =>
    inputOf(c).EmailTags as unknown as { Name: string; Value: string }[]

  // SES folds `ses:feedback-id-a` into field `a` of the header it writes.
  it("sets the workspace token as SES's feedback-id-a tag", async () => {
    const c = client()
    await sesTransport({ client: c, feedbackToken }).send(message)
    expect(tagsOf(c)).toContainEqual({
      Name: "ses:feedback-id-a",
      Value: feedbackToken(message.tenantId),
    })
  })

  // ⚠ SES WRITES ITS OWN HEADER AND GOOGLE WANTS ONE PER MESSAGE. A second one
  // in the raw bytes would be refused or leave two.
  it("writes no Feedback-ID header into the raw message", async () => {
    const c = client()
    await sesTransport({ client: c, feedbackToken }).send(message)
    expect(rawOf(c).toLowerCase()).not.toContain("feedback-id")
  })

  it("gives different tenants different tokens", async () => {
    const one = client()
    const two = client()
    await sesTransport({ client: one, feedbackToken }).send(message)
    await sesTransport({ client: two, feedbackToken }).send({
      ...message,
      tenantId: "ten-2",
    })
    const value = (c: Parameters<typeof inputOf>[0]) =>
      tagsOf(c).find((t) => t.Name === "ses:feedback-id-a")?.Value
    expect(value(one)).toBeDefined()
    expect(value(two)).toBeDefined()
    expect(value(one)).not.toBe(value(two))
  })

  // ⚠ I10'S OWN MAIL TAKES THE SAME PATH: its tenant is a real one, and any
  // tenant id at all still yields a token rather than failing the send.
  it("still sends, with a token, for i10's own system mail", async () => {
    const c = client()
    const outcome = await sesTransport({ client: c, feedbackToken }).send({
      ...message,
      tenantId: "",
      from: "i10 <no-reply@notifications.i10.tech>",
    })
    expect(outcome.status).toBe("sent")
    expect(tagsOf(c).map((t) => t.Name)).toContain("ses:feedback-id-a")
  })

  it("sets no tag when no token is configured", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    expect(tagsOf(c).map((t) => t.Name)).toEqual(["i10_message_id"])
  })

  // ⚠ NO CALLER CAN SET IT, BY TAG OR BY HEADER. Both are checked with a token
  // configured, and without, since the reservation must not depend on us having
  // one to set.
  it.each([
    ["with a token", { feedbackToken }],
    ["without a token", {}],
  ])("refuses a caller's tag or header, %s", async (_label, opts) => {
    const c = client()
    await sesTransport({ client: c, ...opts }).send({
      ...message,
      tags: [
        { name: "ses:feedback-id-a", value: "victim" },
        { name: "ses:feedback-id-b", value: "victim" },
      ],
      headers: {
        "Feedback-ID": "victim:::i10mail",
        "X-SES-MESSAGE-TAGS": "ses:feedback-id-a=victim",
      },
    })

    const forged = tagsOf(c).filter((t) => t.Value === "victim")
    expect(forged).toEqual([])
    expect(tagsOf(c).filter((t) => t.Name === "ses:feedback-id-a")).toHaveLength(
      "feedbackToken" in opts ? 1 : 0,
    )
    expect(rawOf(c)).not.toContain("victim")
  })
})

describe("attachments", () => {
  const withFile = {
    ...message,
    attachments: [
      { filename: "receipt.pdf", content: Buffer.from("pdf").toString("base64") },
    ],
  }

  // ⚠ `Content.Simple` CANNOT EXPRESS A FILE. Sending one through it would
  // silently drop the attachment: SES accepts the call, the customer is billed,
  // and the recipient gets a message with nothing attached.
  it("switches to raw MIME when there is one", async () => {
    const c = client()
    await sesTransport({ client: c }).send(withFile)

    const content = inputOf(c).Content as unknown as {
      Raw?: { Data: Uint8Array }
      Simple?: unknown
    }
    expect(content.Simple).toBeUndefined()
    expect(Buffer.from(content.Raw!.Data).toString("utf8")).toContain(
      'filename="receipt.pdf"',
    )
  })

  // ⚠ AND `Destination` STILL CARRIES THE RECIPIENTS, WHICH IS WHAT KEEPS BCC
  // BLIND. The raw message has no Bcc header; SES delivers from this list.
  it("still passes the destination alongside the raw bytes", async () => {
    const c = client()
    await sesTransport({ client: c }).send({
      ...withFile,
      bcc: ["hidden@example.com"],
    })

    expect(inputOf(c).Destination).toMatchObject({
      ToAddresses: ["a@example.com"],
      BccAddresses: ["hidden@example.com"],
    })
    const raw = Buffer.from(
      (inputOf(c).Content as unknown as { Raw: { Data: Uint8Array } }).Raw.Data,
    ).toString("utf8")
    expect(raw).not.toContain("hidden@example.com")
  })

  /**
   * ⚠ RAW EVEN WITH NOTHING ATTACHED, WHICH IS THE OPPOSITE OF WHAT THIS FILE
   * USED TO ASSERT. `Content.Simple` cannot carry a `Message-ID`, so choosing it
   * for the common case meant choosing to lose the duplicate mitigation on every
   * ordinary send. There is only one path now.
   */
  it("uses raw content even without an attachment", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    const content = inputOf(c).Content as unknown as { Raw?: unknown; Simple?: unknown }
    expect(content.Simple).toBeUndefined()
    expect(content.Raw).toBeDefined()
  })

  // ⚠ Nothing to mix, so no `multipart/mixed`. Wrapping a single body in one
  // would work and would make a plain send structurally indistinguishable from
  // one carrying a file.
  it("does not wrap a message with no attachments in multipart/mixed", async () => {
    const c = client()
    await sesTransport({ client: c }).send(message)
    expect(rawOf(c)).not.toContain("multipart/mixed")
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
