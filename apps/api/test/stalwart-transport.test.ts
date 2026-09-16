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

/** A mailer that records what it was handed and claims success. */
function mailer(behaviour?: () => never) {
  const calls: { raw: string; envelope: { from: string; to: string[] } }[] = []
  return {
    calls,
    sendMail: mock(
      async (m: { raw: string; envelope: { from: string; to: string[] } }) => {
        if (behaviour) behaviour()
        calls.push(m)
        return { messageId: "<queued@mail.i10.tech>" }
      },
    ),
  }
}

const transport = (over: Partial<Parameters<typeof stalwartTransport>[0]> = {}) => {
  const m = mailer()
  return {
    mailer: m,
    t: stalwartTransport({
      mailer: m as never,
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
    // The message itself must survive untouched — the signature covers it.
    expect(signed).toContain("\r\n\r\nbody\r\n")
  })

  /**
   * ⚠ THE FAILURE THIS GUARDS IS A SIGNER THAT RETURNS SOMETHING PLAUSIBLE. An
   * unusable key must stop the send, not produce a header that verifies nowhere
   * while every log we keep calls the message signed.
   */
  it("throws on an unusable key rather than returning the message unsigned", async () => {
    await expect(
      signMessage("From: a@b.test\r\n\r\nx\r\n", "b.test", {
        selector: "sel",
        privateKey: "not-a-key",
      }),
    ).rejects.toThrow()
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
    expect(m.calls[0]?.raw).toMatch(/d=example\.com;/)
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
   * ⚠ THE RECORDED ID MUST RESOLVE TO SOMETHING. It used to be nodemailer's
   * client-side UUID, which is never sent and which Stalwart never sees — a
   * column of values that look like ids and identify nothing. Stalwart's 250
   * carries no queue id to use instead (`250 2.0.0 Message queued for
   * delivery.`), so the honest identifier is the `Message-ID` we wrote, which
   * reaches the wire unmodified and appears in Stalwart's logs.
   */
  it("records the Message-ID it actually sent, not the mailer's own id", async () => {
    const { t, mailer: m } = transport()
    const msg = message()

    const outcome = await t.send(msg)

    const expected = `<${msg.id}@example.com>`
    expect(outcome).toEqual({ status: "sent", providerMessageId: expected })
    // And it is the same value that went on the wire.
    expect(m.calls[0]?.raw).toContain(`Message-ID: ${expected}`)
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
    expect(m.calls[0]?.raw).not.toContain("Bcc:")
    expect(m.calls[0]?.raw).not.toContain("hidden@elsewhere.test")
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
    expect(m.sendMail).not.toHaveBeenCalled()
  })

  it("rejects a From with no domain at all", async () => {
    const { t } = transport()
    const outcome = await t.send(message({ from: "nonsense" }))
    expect(outcome.status).toBe("rejected")
  })
})

describe("classifying a submission failure", () => {
  /**
   * ⚠ 5xx IS PERMANENT AND 4xx IS NOT, AND COLLAPSING THEM COSTS MAIL IN BOTH
   * DIRECTIONS: a retried 5xx burns the attempt budget to reach the same
   * answer, and a dropped 4xx throws away a message the server asked us to
   * resend later.
   */
  it("treats a 5xx as permanent and a 4xx as temporary", async () => {
    const permanent = Object.assign(new Error("550 no such user"), {
      responseCode: 550,
    })
    const temporary = Object.assign(new Error("451 try later"), { responseCode: 451 })

    for (const [err, status] of [
      [permanent, "rejected"],
      [temporary, "deferred"],
    ] as const) {
      const { t } = transport({
        mailer: {
          sendMail: async () => {
            throw err
          },
        } as never,
      })
      expect((await t.send(message())).status).toBe(status)
    }
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
    expect(m.sendMail).not.toHaveBeenCalled()
  })

  // ⚠ A SOCKET THAT NEVER OPENED SAYS NOTHING ABOUT THE MESSAGE.
  it("defers an error carrying no reply code", async () => {
    const { t } = transport({
      mailer: {
        sendMail: async () => {
          throw new Error("ECONNREFUSED")
        },
      } as never,
    })

    expect((await t.send(message())).status).toBe("deferred")
  })
})
