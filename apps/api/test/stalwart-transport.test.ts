import type { RawMessage } from "@upyo/core"
import type { SmtpReceipt } from "@upyo/smtp"
import { describe, expect, it, mock } from "bun:test"
import { generateDkimKeypair } from "../src/domains/dkim.js"
import { signMessage } from "../src/send/dkim.js"
import { stalwartTransport } from "../src/send/stalwart.js"
import type { OutboundMessage } from "../src/send/transport.js"

const keypair = generateDkimKeypair()

const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: "01931b2c-0000-7000-8000-000000000001",
  tenantId: "ten-1",
  from: "i10 test <noreply@example.com>",
  to: ["someone@elsewhere.test"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hello",
  text: "It works.",
  html: null,
  ...over,
})

/** The bytes as the mailer received them. */
const rawOf = (m: RawMessage): string =>
  new TextDecoder().decode(m.content as Uint8Array)

/** A mailer that records what it was handed and claims success. */
function mailer(receipt?: SmtpReceipt) {
  const calls: RawMessage[] = []
  return {
    calls,
    sendRaw: mock(async (m: RawMessage): Promise<SmtpReceipt> => {
      calls.push(m)
      return (
        receipt ?? {
          successful: true,
          provider: "smtp",
          messageId: "smtp-1757980000000-abc123xyz",
          rejectedRecipients: [],
        }
      )
    }),
  }
}

/** A failed receipt in the shape upyo builds one. */
const failure = (
  code: string,
  providerDetails?: unknown,
  retryable = false,
): SmtpReceipt => ({
  successful: false,
  provider: "smtp",
  errorMessages: [`failed: ${code}`],
  errors: [
    {
      message: `failed: ${code}`,
      code,
      category: "unknown",
      retryable,
      provider: "smtp",
      providerDetails,
    },
  ],
  retryable,
})

const transport = (over: Partial<Parameters<typeof stalwartTransport>[0]> = {}) => {
  const m = mailer()
  return {
    mailer: m,
    t: stalwartTransport({
      mailer: m,
      domainSending: async () => ({
        dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
        bounceSubdomain: "bounce",
      }),
      ...over,
    }),
  }
}

describe("signing", () => {
  it("prepends a signature naming the customer's domain and our selector", async () => {
    const signed = await signMessage(
      "From: a@b.test\r\nSubject: x\r\n\r\nbody\r\n",
      "b.test",
      {
        selector: keypair.selector,
        privateKey: keypair.privateKey,
      },
    )

    expect(signed).toMatch(/^DKIM-Signature:/)
    expect(signed).toContain("d=b.test")
    expect(signed).toContain(`s=${keypair.selector}`)
    expect(signed).toContain("a=rsa-sha256")
    expect(signed).toContain("c=relaxed/relaxed")
    // The message itself must survive untouched — the signature covers it.
    expect(signed).toContain("\r\n\r\nbody\r\n")
  })

  /**
   * ⚠ THE COLUMN HOLDS BARE BASE64 DER, NOT PEM, AND THE RE-ARMOURING STEP THAT
   * USED TO BRIDGE THE TWO IS GONE. If upyo ever stopped accepting an unarmoured
   * key this would fail here rather than in production, where the symptom is
   * every direct send rejected at once.
   */
  it("signs with the stored key format directly, without PEM armour", async () => {
    expect(keypair.privateKey).not.toContain("BEGIN PRIVATE KEY")

    const signed = await signMessage("From: a@b.test\r\n\r\nx\r\n", "b.test", {
      selector: keypair.selector,
      privateKey: keypair.privateKey,
    })

    expect(signed).toMatch(/^DKIM-Signature:/)
  })

  /**
   * ⚠ THE FAILURE THIS GUARDS IS A SIGNER THAT RETURNS SOMETHING PLAUSIBLE. An
   * unusable key must stop the send, not produce a header that verifies nowhere
   * while every log we keep calls the message signed. nodemailer returned the
   * message essentially untouched and needed a hand-written check to catch it;
   * upyo throws, and this is what holds it to that.
   */
  it("throws on an unusable key rather than returning the message unsigned", async () => {
    await expect(
      signMessage("From: a@b.test\r\n\r\nx\r\n", "b.test", {
        selector: "sel",
        privateKey: "not-a-key",
      }),
    ).rejects.toThrow()
  })

  /**
   * ⚠ EVERY HEADER `buildRawMessage` EMITS, AND THE ABSENT ONES TOO. A name in
   * `h=` with no matching header is hashed as the null string (RFC 6376 §3.7),
   * which is oversigning — it stops an intermediary ADDING a `Cc` the signature
   * never covered. This differs from nodemailer, which dropped absent names from
   * the tag, so it is asserted rather than assumed.
   */
  it("covers the headers we emit, including ones this message lacks", async () => {
    const signed = await signMessage("From: a@b.test\r\n\r\nx\r\n", "b.test", {
      selector: keypair.selector,
      privateKey: keypair.privateKey,
    })

    const h = /h=([^;]+);/.exec(signed)?.[1]
    expect(h).toBe(
      "from:to:cc:reply-to:subject:date:message-id:mime-version:content-type:content-transfer-encoding",
    )
  })

  /** RFC 5322 caps a line at 998 octets, and an unfoldable header is unsendable. */
  it("produces a signature line inside the RFC line limit", async () => {
    const signed = await signMessage("From: a@b.test\r\n\r\nx\r\n", "b.test", {
      selector: keypair.selector,
      privateKey: keypair.privateKey,
    })

    const longest = Math.max(...signed.split("\r\n").map((l) => l.length))
    expect(longest).toBeLessThanOrEqual(998)
  })
})

describe("the direct transport", () => {
  it("signs as the From domain, unwrapping a display name", async () => {
    const { t, mailer: m } = transport()

    const outcome = await t.send(message())

    expect(outcome.status).toBe("sent")
    // ⚠ THE TAG, WITH ITS TERMINATOR. Asserting the bare substring would also
    // pass for `d=example.com>` — the exact malformed value this unwrapping
    // exists to prevent, since the From carries a display name.
    expect(rawOf(m.calls[0]!)).toMatch(/d=example\.com;/)
  })

  /**
   * ⚠ SPF ALIGNMENT IS THE WHOLE REASON THE ENVELOPE IS NOT ON i10.tech, and the
   * message id in it is what makes a returning DSN attributable.
   */
  it("returns bounces to the customer's own domain, carrying the message id", async () => {
    const { t, mailer: m } = transport()
    const msg = message()

    await t.send(msg)

    expect(m.calls[0]?.envelope.from).toBe(`bounce+${msg.id}@bounce.example.com`)
  })

  /**
   * ⚠ THE RECORDED ID MUST RESOLVE TO SOMETHING, AND upyo'S IS SYNTHETIC HERE.
   * Stalwart's `250 2.0.0 Message queued for delivery.` carries no queue id, so
   * upyo's extractor finds nothing and falls back to
   * `smtp-${Date.now()}-${random}` — a value that looks like an id and resolves
   * nowhere, which is the exact bug this column already had once when it held
   * nodemailer's client-side UUID. The honest identifier is the `Message-ID` we
   * wrote, which reaches the wire unmodified and appears in Stalwart's logs.
   */
  it("records the Message-ID it sent, not the mailer's synthesised id", async () => {
    const { t, mailer: m } = transport()
    const msg = message()

    const outcome = await t.send(msg)

    const expected = `<${msg.id}@example.com>`
    expect(outcome).toEqual({ status: "sent", providerMessageId: expected })
    expect(outcome).not.toMatchObject({
      providerMessageId: "smtp-1757980000000-abc123xyz",
    })
    // And it is the same value that went on the wire.
    expect(rawOf(m.calls[0]!)).toContain(`Message-ID: ${expected}`)
  })

  // ⚠ THE KEY MUST BELONG TO THE TENANT WHOSE MESSAGE THIS IS, not merely to
  // whoever owns a row with that name — which is what scoping the lookup buys
  // beyond fixing the RLS raise.
  it("looks the key up for the sending message's own tenant", async () => {
    const seen: { domain: string; tenantId: string }[] = []
    const { t } = transport({
      domainSending: async (domain: string, tenantId: string) => {
        seen.push({ domain, tenantId })
        return {
          dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
          bounceSubdomain: "bounce",
        }
      },
    })

    await t.send(message({ tenantId: "ten-42" }))

    expect(seen).toEqual([{ domain: "example.com", tenantId: "ten-42" }])
  })

  /**
   * ⚠ BLIND COPY IS BLIND BECAUSE THE HEADER IS ABSENT. The envelope is the only
   * thing naming a bcc recipient; a `Bcc:` header would disclose them to
   * everyone else on the message.
   */
  it("puts bcc in the envelope and never in the headers", async () => {
    const { t, mailer: m } = transport()

    await t.send(message({ bcc: ["hidden@elsewhere.test"] }))

    expect(m.calls[0]?.envelope.to).toContain("hidden@elsewhere.test")
    expect(rawOf(m.calls[0]!)).not.toContain("Bcc:")
    expect(rawOf(m.calls[0]!)).not.toContain("hidden@elsewhere.test")
  })

  /**
   * ⚠ LEAVING `encoding` UNSET IS WHAT MAKES upyo VALIDATE THE BYTES. Naming it
   * would skip the analysis pass that enforces CRLF endings, the 998-octet line
   * limit and the absence of NUL — the pass that found two latent faults in
   * `buildRawMessage`.
   */
  it("hands over unencoded bytes and lets the client classify them", async () => {
    const { t, mailer: m } = transport()

    await t.send(message())

    expect(m.calls[0]?.content).toBeInstanceOf(Uint8Array)
    expect(m.calls[0]?.encoding).toBeUndefined()
  })

  /**
   * ⚠ REFUSED RATHER THAN SENT UNSIGNED. A domain with no key is a provisioning
   * bug, and mail that leaves unsigned fails DMARC in the recipient's spam
   * folder rather than in our error count.
   */
  it("rejects a domain with no DKIM key instead of sending", async () => {
    const { t, mailer: m } = transport({ domainSending: async () => null })

    const outcome = await t.send(message())

    expect(outcome).toEqual({
      status: "rejected",
      reason: "no DKIM key for example.com",
    })
    expect(m.sendRaw).not.toHaveBeenCalled()
  })

  /**
   * ⚠ THE ENVELOPE TAKES BARE ADDRESSES AND THE HEADER KEEPS THE NAME. `RCPT TO`
   * with `Bob <bob@x.test>` reads the local part as `Bob <bob` — a space and an
   * angle bracket, which is not a valid address — so the submission client
   * refuses the whole message. The previous client unwrapped this silently, so
   * every send with a display name in `to` depended on behaviour we no longer
   * have. Getting this wrong fails those sends permanently, on the direct route
   * only.
   */
  it("unwraps display names for the envelope while the header keeps them", async () => {
    const { t, mailer: m } = transport()

    const outcome = await t.send(
      message({
        to: ["Bob Loblaw <bob@elsewhere.test>"],
        cc: ["cc@elsewhere.test"],
        bcc: ["Hidden One <hidden@elsewhere.test>"],
      }),
    )

    expect(outcome.status).toBe("sent")
    expect(m.calls[0]?.envelope.to).toEqual([
      "bob@elsewhere.test",
      "cc@elsewhere.test",
      "hidden@elsewhere.test",
    ])
    // The recipient still sees the name — that is the header's job, not the
    // envelope's.
    expect(rawOf(m.calls[0]!)).toContain('To: "Bob Loblaw" <bob@elsewhere.test>')
    // ...and bcc stays blind either way.
    expect(rawOf(m.calls[0]!)).not.toContain("Hidden One")
  })

  /**
   * ⚠ REFUSED, NOT QUIETLY DROPPED FROM THE ENVELOPE. Filtering an unparseable
   * recipient out would deliver to everyone else and report `sent`, with one
   * person silently missing and nothing anywhere recording it.
   */
  it("rejects rather than silently dropping an unparseable recipient", async () => {
    const { t, mailer: m } = transport()

    const outcome = await t.send(
      message({ to: ["someone@elsewhere.test", "nonsense"] }),
    )

    expect(outcome).toEqual({
      status: "rejected",
      reason: "unparseable recipient: nonsense",
    })
    expect(m.sendRaw).not.toHaveBeenCalled()
  })

  it("rejects a From with no domain at all", async () => {
    const { t } = transport()
    const outcome = await t.send(message({ from: "nonsense" }))
    expect(outcome.status).toBe("rejected")
  })

  /**
   * ⚠ AN UNUSABLE KEY MUST NOT REACH THE MAILER. The signer throws, and this is
   * what proves the transport turns that into a refusal rather than letting an
   * unsigned message through.
   */
  it("rejects without submitting when the key will not import", async () => {
    const { t, mailer: m } = transport({
      domainSending: async () => ({
        dkim: { selector: "sel", privateKey: "not-a-key" },
        bounceSubdomain: "bounce",
      }),
    })

    const outcome = await t.send(message())

    expect(outcome.status).toBe("rejected")
    expect(m.sendRaw).not.toHaveBeenCalled()
  })
})

/**
 * ⚠ SMTP CAN TAKE A MESSAGE AND STILL REFUSE SOME OF ITS RECIPIENTS, which is
 * information the previous client never surfaced. The send really did succeed,
 * so the outcome stays `sent` — this callback is the only place the missing
 * recipients become visible.
 */
describe("partial acceptance", () => {
  it("reports rejected recipients without failing the send", async () => {
    const seen: unknown[] = []
    const m = mailer({
      successful: true,
      provider: "smtp",
      messageId: "queued",
      rejectedRecipients: [
        {
          recipient: "gone@elsewhere.test",
          code: 550,
          response: "550 5.1.1 no such user",
          retryable: false,
        },
      ],
    })
    const t = stalwartTransport({
      mailer: m,
      domainSending: async () => ({
        dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
        bounceSubdomain: "bounce",
      }),
      onRejectedRecipients: (e) => seen.push(e),
    })

    const outcome = await t.send(message({ tenantId: "ten-7" }))

    expect(outcome.status).toBe("sent")
    expect(seen).toEqual([
      {
        messageId: "01931b2c-0000-7000-8000-000000000001",
        tenantId: "ten-7",
        recipients: [
          {
            recipient: "gone@elsewhere.test",
            code: 550,
            response: "550 5.1.1 no such user",
            retryable: false,
          },
        ],
      },
    ])
  })

  it("stays silent when every recipient was accepted", async () => {
    const seen: unknown[] = []
    const { t } = transport({ onRejectedRecipients: (e) => seen.push(e) })

    await t.send(message())

    expect(seen).toEqual([])
  })
})

describe("classifying a submission failure", () => {
  const sendWith = async (receipt: SmtpReceipt) => {
    const m = mailer(receipt)
    const t = stalwartTransport({
      mailer: m,
      domainSending: async () => ({
        dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
        bounceSubdomain: "bounce",
      }),
    })
    return t.send(message())
  }

  /**
   * ⚠ 5xx IS PERMANENT AND 4xx IS NOT, AND COLLAPSING THEM COSTS MAIL IN BOTH
   * DIRECTIONS: a retried 5xx burns the attempt budget to reach the same
   * answer, and a dropped 4xx throws away a message the server asked us to
   * resend later.
   */
  it("treats a 5xx as permanent and a 4xx as temporary", async () => {
    for (const [code, command, status] of [
      ["smtp.550", "RCPT TO", "rejected"],
      ["smtp.451", "RCPT TO", "deferred"],
      ["smtp.552", "DATA", "rejected"],
      ["smtp.421", "DATA", "deferred"],
    ] as const) {
      const outcome = await sendWith(failure(code, { command, response: code }))
      expect(outcome.status).toBe(status)
    }
  })

  /**
   * ⚠ THE REGRESSION THIS PREVENTS IS A QUEUE-WIDE EXTINCTION EVENT. A mistyped
   * submission password answers `535` for EVERY message, and a hard 5xx read as
   * a verdict on the message would burn the entire backlog to `failed` in one
   * batch — each row blaming the message rather than the credential. The session
   * is ours to fix and the mail is still deliverable, so it waits.
   */
  it("defers a 5xx from the session rather than the message", async () => {
    for (const command of [
      "AUTH PLAIN",
      "AUTH LOGIN",
      "EHLO",
      "HELO",
      "STARTTLS",
      "GREETING",
    ]) {
      const outcome = await sendWith(
        failure("smtp.535", { command, response: "535 bad" }),
      )
      expect(outcome.status).toBe("deferred")
    }
  })

  /**
   * ⚠ A LOCAL FAULT upyo NAMES IS PERMANENT, BECAUSE IT REPRODUCES EXACTLY. An
   * envelope it will not accept or a message over the server's advertised size
   * answers the same way on every retry, so deferring only spends the attempt
   * budget to reach it again.
   */
  it("rejects a deterministic local fault", async () => {
    for (const code of [
      "smtp.envelope-invalid",
      "smtp.raw-message-invalid",
      "smtp.message-size-exceeded",
      "smtp.8bitmime-unsupported",
      "smtp.smtputf8-unsupported",
    ]) {
      expect((await sendWith(failure(code))).status).toBe("rejected")
    }
  })

  /**
   * ⚠ THE ONE THAT MATTERS MOST: upyo's OWN `retryable` IS NOT TRUSTED. When it
   * does not recognise a failure it classifies by SUBSTRING MATCHING ON THE
   * ERROR TEXT and ends at `{ category: "unknown", retryable: false }`. Taken at
   * face value, an expired certificate would be permanent and would destroy
   * every message in the queue. Our rule is the opposite and always has been: an
   * error we cannot read is temporary.
   */
  it("defers an unrecognised failure even when the receipt calls it permanent", async () => {
    for (const code of ["unknown", "network", "validation", "auth", "rejected"]) {
      const outcome = await sendWith(failure(code, undefined, false))
      expect(outcome.status).toBe("deferred")
    }
  })

  // ⚠ A SOCKET THAT NEVER OPENED SAYS NOTHING ABOUT THE MESSAGE.
  it("defers an error carrying no reply code", async () => {
    const outcome = await sendWith({
      successful: false,
      provider: "smtp",
      errorMessages: ["connect ECONNREFUSED 10.0.0.1:587"],
      retryable: true,
    })
    expect(outcome.status).toBe("deferred")
  })

  /**
   * ⚠ THE REGRESSION: A LOOKUP FAILURE IS NOT A VERDICT ON THE MESSAGE. This
   * used to share a catch with signing and came back `rejected`, which
   * handleBatch treats as permanent — so a momentary database blip marked a
   * perfectly deliverable message `failed` and it was never retried.
   */
  it("defers when the key lookup itself fails, rather than failing the message", async () => {
    const { t, mailer: m } = transport({
      domainSending: async () => {
        throw new Error('invalid input syntax for type uuid: ""')
      },
    })

    const outcome = await t.send(message())

    expect(outcome.status).toBe("deferred")
    expect(m.sendRaw).not.toHaveBeenCalled()
  })

  /**
   * ⚠ `sendRaw` RETURNS FAILURES RATHER THAN THROWING THEM, so a throw means
   * something outside the SMTP conversation went wrong — in practice an abort.
   * Nothing about the message, so it waits.
   */
  it("defers when the client throws instead of returning a receipt", async () => {
    const { t } = transport({
      mailer: {
        sendRaw: async () => {
          throw new Error("The operation was aborted.")
        },
      },
    })

    expect((await t.send(message())).status).toBe("deferred")
  })
})
