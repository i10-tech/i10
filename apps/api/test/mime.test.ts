import { describe, expect, it } from "vitest"
import {
  buildRawMessage,
  encodeWord,
  formatAddressList,
  type MimeAttachment,
} from "../src/send/mime.js"
import type { OutboundMessage } from "../src/send/transport.js"

/**
 * The raw MIME builder.
 *
 * Nothing here validates that a mail client renders the result — that is what
 * an end-to-end send proves. What these assert are the properties whose failure
 * is silent: a header a receiver drops, a Bcc that stops being blind, a
 * boundary that could appear inside a body.
 */

const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071",
  tenantId: "ten-1",
  from: "hello@i10.tech",
  to: ["user@example.com"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hi",
  text: "hello",
  ...over,
})

const file = (over: Partial<MimeAttachment> = {}): MimeAttachment => ({
  filename: "receipt.pdf",
  content_type: "application/pdf",
  content: Buffer.from("a pdf, honestly").toString("base64"),
  ...over,
})

const AT = new Date("2026-09-02T10:00:00Z")

describe("the envelope", () => {
  // ⚠ CRLF, INCLUDING THE BLANK LINES. A bare LF is accepted by some receivers,
  // rejected by others, and can fail DKIM on the ones that accept it — a
  // "sometimes lands in spam" bug rather than an error.
  it("ends every line with CRLF", () => {
    const raw = buildRawMessage(message(), [file()], AT)
    expect(raw).not.toMatch(/[^\r]\n/)
  })

  // ⚠ THE PROPERTY THAT KEEPS BLIND COPY BLIND. SES takes the recipients from
  // `Destination`; a Bcc header here would deliver the same mail and disclose
  // every hidden recipient to everyone else on it.
  it("never writes a Bcc header", () => {
    const raw = buildRawMessage(
      message({ bcc: ["secret@example.com"] }),
      [file()],
      AT,
    )
    expect(raw.toLowerCase()).not.toContain("bcc:")
    expect(raw).not.toContain("secret@example.com")
  })

  // The retry of an at-least-once send has to be the same message, or receivers
  // show it twice instead of collapsing it.
  it("carries the derived Message-ID", () => {
    const raw = buildRawMessage(message(), [file()], AT)
    expect(raw).toContain(
      "Message-ID: <0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071@i10.tech>",
    )
  })

  it("is byte-identical when built twice", () => {
    const one = buildRawMessage(message(), [file()], AT)
    const two = buildRawMessage(message(), [file()], AT)
    expect(one).toBe(two)
  })

  it("keeps caller headers but not the ones we own", () => {
    const raw = buildRawMessage(
      message({
        headers: {
          "X-Campaign": "spring",
          From: "attacker@evil.test",
          "Message-ID": "<forged@evil.test>",
        },
      }),
      [file()],
      AT,
    )

    expect(raw).toContain("X-Campaign: spring")
    expect(raw).not.toContain("attacker@evil.test")
    expect(raw).not.toContain("forged@evil.test")
  })

  // ⚠ HEADER INJECTION. A newline in a header value would let a caller append
  // headers — or a whole second MIME part — to their own message.
  it("flattens newlines in a caller header value", () => {
    const raw = buildRawMessage(
      message({ headers: { "X-Note": "one\r\nBcc: leak@evil.test" } }),
      [file()],
      AT,
    )
    expect(raw).toContain("X-Note: one Bcc: leak@evil.test")
    expect(raw.toLowerCase()).not.toContain("\r\nbcc:")
  })
})

describe("structure", () => {
  it("nests alternative inside mixed when there are both bodies", () => {
    const raw = buildRawMessage(
      message({ text: "plain", html: "<p>rich</p>" }),
      [file()],
      AT,
    )

    expect(raw).toContain("Content-Type: multipart/mixed;")
    expect(raw).toContain("Content-Type: multipart/alternative;")
    // ⚠ Plain first. RFC 2046 says the last part is the richest, so reversing
    // these shows plain text to every client that understands html.
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"))
  })

  it("does not nest when there is only one body", () => {
    const raw = buildRawMessage(message({ text: "plain", html: null }), [file()], AT)
    expect(raw).not.toContain("multipart/alternative")
  })

  it("closes the outer boundary", () => {
    const raw = buildRawMessage(message(), [file()], AT)
    const boundary = /boundary="([^"]+)"/.exec(raw)![1]!
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
  })

  // ⚠ A BOUNDARY THAT APPEARS INSIDE A PART TRUNCATES THE MESSAGE THERE. Every
  // part being base64 makes that impossible: `=_` is not in the alphabet.
  it("uses a boundary no base64 body can contain", () => {
    const raw = buildRawMessage(message(), [file()], AT)
    const boundary = /boundary="([^"]+)"/.exec(raw)![1]!
    expect(boundary).toContain("=_")
  })
})

describe("attachments", () => {
  it("declares the filename and disposition", () => {
    const raw = buildRawMessage(message(), [file()], AT)
    expect(raw).toContain('Content-Disposition: attachment; filename="receipt.pdf"')
    expect(raw).toContain("Content-Type: application/pdf;")
  })

  it("falls back to octet-stream without a type", () => {
    const raw = buildRawMessage(message(), [file({ content_type: undefined })], AT)
    expect(raw).toContain("Content-Type: application/octet-stream;")
  })

  // ⚠ RE-WRAPPED, NOT RE-ENCODED. Decoding to re-encode would double what a
  // ten-megabyte attachment costs in memory and could only produce the same
  // bytes back.
  it("re-wraps the caller's base64 at 76 columns without altering it", () => {
    const content = Buffer.from("x".repeat(500)).toString("base64")
    const raw = buildRawMessage(message(), [file({ content })], AT)

    const encoded = raw
      .split("Content-Disposition: attachment;")[1]!
      .split(`\r\n\r\n`)[1]!
      .split("\r\n--")[0]!

    expect(encoded.split("\r\n").every((line) => line.length <= 76)).toBe(true)
    expect(encoded.replace(/\r\n/g, "")).toBe(content)
  })

  it("accepts base64 the caller already wrapped", () => {
    const content = Buffer.from("y".repeat(300)).toString("base64")
    const wrapped = content.match(/.{1,40}/g)!.join("\n")
    const raw = buildRawMessage(message(), [file({ content: wrapped })], AT)
    expect(raw).toContain(content.slice(0, 76))
  })

  it("carries several files", () => {
    const raw = buildRawMessage(
      message(),
      [file({ filename: "a.pdf" }), file({ filename: "b.png" })],
      AT,
    )
    expect(raw).toContain('filename="a.pdf"')
    expect(raw).toContain('filename="b.png"')
  })
})

describe("encoding", () => {
  // ⚠ A RAW UTF-8 SUBJECT IS NOT LEGAL IN A HEADER AND FAILS QUIETLY — rendered
  // by some receivers, mojibake in others, dropped by the rest.
  it("encodes a non-ASCII subject as an encoded-word", () => {
    expect(encodeWord("Café")).toBe(
      `=?UTF-8?B?${Buffer.from("Café", "utf8").toString("base64")}?=`,
    )
  })

  it("leaves plain ASCII alone", () => {
    expect(encodeWord("Your receipt")).toBe("Your receipt")
  })

  it("puts an encoded subject in the header", () => {
    const raw = buildRawMessage(message({ subject: "Café ☕" }), [file()], AT)
    expect(raw).toContain("Subject: =?UTF-8?B?")
  })
})

describe("addresses", () => {
  // ⚠ ONLY THE DISPLAY NAME IS ENCODED. An encoded-word in the addr-spec is
  // meaningless and produces a header no receiver can route.
  it("encodes the name and never the address", () => {
    const formatted = formatAddressList(["Café Owner <hello@i10.tech>"])
    expect(formatted).toContain("<hello@i10.tech>")
    expect(formatted).toContain("=?UTF-8?B?")
  })

  it("quotes an ASCII display name", () => {
    expect(formatAddressList(['Bob "The Sender" <bob@x.com>'])).toBe(
      '"Bob \\"The Sender\\"" <bob@x.com>',
    )
  })

  it("leaves a bare address bare", () => {
    expect(formatAddressList(["bob@x.com"])).toBe("bob@x.com")
  })

  it("joins a list with commas", () => {
    expect(formatAddressList(["a@x.com", "b@x.com"])).toBe("a@x.com, b@x.com")
  })
})
