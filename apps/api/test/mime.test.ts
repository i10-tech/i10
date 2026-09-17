import { describe, expect, it } from "bun:test"
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
    const raw = buildRawMessage(message({ bcc: ["secret@example.com"] }), [file()], AT)
    expect(raw.toLowerCase()).not.toContain("bcc:")
    expect(raw).not.toContain("secret@example.com")
  })

  // The retry of an at-least-once send has to be the same message, or receivers
  // show it twice instead of collapsing it.
  it("carries the derived Message-ID", () => {
    const raw = buildRawMessage(message(), [file()], AT)
    expect(raw).toContain("Message-ID: <0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071@i10.tech>")
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

/**
 * RFC 5322 line limits.
 *
 * ⚠ THESE ARE NOT STYLE ASSERTIONS. `To:` accepts 50 addresses of up to 320
 * characters, so an unfolded recipient list reaches sixteen kilobytes on ONE
 * LINE — well past the 998-octet hard limit, and that is what this composer
 * emitted until folding existed. SES took those messages and did whatever it
 * does; the direct route's validator refuses them, so the same send worked or
 * failed depending on the route. That route-visible difference is the thing the
 * whole routing design exists to prevent.
 */
describe("line limits", () => {
  const lines = (raw: string) => raw.split("\r\n")
  const longest = (raw: string) =>
    Math.max(...lines(raw).map((l) => Buffer.byteLength(l, "utf8")))

  /** RFC 5322 §2.1.1. Nothing may exceed this and still be a valid message. */
  const HARD_LIMIT = 998

  it("folds a fifty-recipient To header", () => {
    const to = Array.from(
      { length: 50 },
      (_, i) => `recipient-number-${i}@elsewhere.example.com`,
    )
    const raw = buildRawMessage(message({ to }), [], AT)

    expect(longest(raw)).toBeLessThanOrEqual(HARD_LIMIT)
    // Every address still present, and none of them split.
    for (const address of to) expect(raw).toContain(address)
    // Folded the way every other mail agent folds: comma ends the line, the
    // continuation begins with whitespace.
    expect(raw).toMatch(/,\r\n /)
  })

  /**
   * ⚠ UNFOLDING MUST REPRODUCE THE ORIGINAL EXACTLY. RFC 5322 removes the CRLF
   * before leading whitespace and KEEPS that whitespace — so breaking at a space
   * and starting the next line with one space is lossless, and adding a space
   * instead silently rewrites the header.
   */
  it("folds losslessly, so unfolding returns the original value", () => {
    const to = Array.from({ length: 30 }, (_, i) => `user${i}@elsewhere.example.com`)
    const raw = buildRawMessage(message({ to }), [], AT)

    const unfolded = raw.replace(/\r\n([ \t])/g, "$1")
    expect(unfolded).toContain(`To: ${to.join(", ")}`)
  })

  it("folds a long subject", () => {
    const subject = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")
    const raw = buildRawMessage(message({ subject }), [], AT)

    expect(longest(raw)).toBeLessThanOrEqual(HARD_LIMIT)
    expect(raw.replace(/\r\n([ \t])/g, "$1")).toContain(`Subject: ${subject}`)
  })

  it("folds a long custom header", () => {
    const raw = buildRawMessage(
      message({
        headers: {
          "X-Trace": Array.from({ length: 60 }, (_, i) => `seg-${i}`).join(" "),
        },
      }),
      [],
      AT,
    )
    expect(longest(raw)).toBeLessThanOrEqual(HARD_LIMIT)
  })

  /**
   * ⚠ RFC 2047 CAPS AN ENCODED-WORD AT 75 CHARACTERS, and one cannot be folded —
   * folding needs whitespace and there is none inside one. A 200-character
   * accented subject produced a single 545-character word: illegal, unfoldable,
   * and unsendable on the direct route.
   */
  it("splits a long non-ASCII subject into several encoded-words", () => {
    const subject = "é".repeat(200)
    const encoded = encodeWord(subject)

    for (const word of encoded.split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75)
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/)
    }
    // Adjacent encoded-words are concatenated WITHOUT the separating whitespace,
    // so the split must be lossless.
    const decoded = encoded
      .split(" ")
      .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"))
      .join("")
    expect(decoded).toBe(subject)

    expect(longest(buildRawMessage(message({ subject }), [], AT))).toBeLessThanOrEqual(
      HARD_LIMIT,
    )
  })

  /**
   * ⚠ SPLIT ON CODE POINTS, NEVER ON BYTES. Each encoded-word is decoded
   * independently, so a multi-byte character cut across two of them decodes to
   * replacement characters in both — mojibake at exactly one point in a subject,
   * which is the kind of bug that gets blamed on the recipient's mail client.
   */
  it("never splits a multi-byte character across two encoded-words", () => {
    const subject = "🙂".repeat(60)
    const decoded = encodeWord(subject)
      .split(" ")
      .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"))
      .join("")

    expect(decoded).toBe(subject)
    expect(decoded).not.toContain("�")
  })

  /** A run of spaces is the customer's, and folding inside one would eat it. */
  it("does not collapse a run of spaces when folding", () => {
    const subject = `${"a".repeat(60)}  ${"b".repeat(60)}`
    const raw = buildRawMessage(message({ subject }), [], AT)

    expect(raw.replace(/\r\n([ \t])/g, "$1")).toContain(`Subject: ${subject}`)
  })

  /** Short headers must come out byte for byte as they always have. */
  it("leaves a header that already fits completely alone", () => {
    const raw = buildRawMessage(message(), [], AT)
    expect(raw).toContain("To: user@example.com\r\n")
    expect(raw).toContain("Subject: Hi\r\n")
  })
})

/**
 * ⚠ HEADERS ARE ASCII, AND A FILENAME IN THE CUSTOMER'S OWN LANGUAGE IS NOT.
 * `réçu.pdf` used to go into `Content-Type` and `Content-Disposition` as raw
 * UTF-8 — not valid RFC 5322, and quiet about it. It became loud when the direct
 * route started classifying such a message as needing SMTPUTF8 and refusing to
 * send it to a server without that capability: the same attachment would arrive
 * through SES and fail permanently through our own MTA.
 */
describe("non-ASCII attachment filenames", () => {
  const named = (filename: string): MimeAttachment => ({
    filename,
    content_type: "application/pdf",
    content: Buffer.from("x").toString("base64"),
  })

  it("keeps the message ASCII-only", () => {
    const raw = buildRawMessage(message(), [named("réçu-مرحبا.pdf")], AT)
    expect(Buffer.from(raw, "utf8").every((b) => b <= 127)).toBe(true)
  })

  // RFC 2231 on Content-Disposition, which is the actual standard for a
  // parameter value that is not ASCII.
  it("uses filename* with percent-encoding on Content-Disposition", () => {
    const raw = buildRawMessage(message(), [named("réçu.pdf")], AT)
    expect(raw).toContain(
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent("réçu.pdf")}`,
    )
  })

  // RFC 2047 on the deprecated Content-Type `name`, which is what the clients
  // that still read it expect.
  it("uses an encoded-word for the Content-Type name", () => {
    const raw = buildRawMessage(message(), [named("réçu.pdf")], AT)
    expect(raw).toContain(`name="${encodeWord("réçu.pdf")}"`)
  })

  /**
   * ⚠ `'`, `(`, `)` AND `*` ARE OUTSIDE RFC 2231's attr-char SET, and
   * `encodeURIComponent` leaves all four alone. `*` and `'` are the delimiters
   * of the `filename*=UTF-8''…` syntax itself, so an apostrophe in a filename
   * would terminate the charset section early.
   */
  it("escapes the characters that would break the parameter syntax", () => {
    const raw = buildRawMessage(message(), [named("l'été (2).pdf")], AT)
    expect(raw).toContain("%27")
    expect(raw).toContain("%28")
    expect(raw).toContain("%29")
    expect(raw).not.toMatch(/filename\*=UTF-8''[^\r\n]*[()']/)
  })

  /** The common case must be untouched, byte for byte. */
  it("leaves an ASCII filename exactly as before", () => {
    const raw = buildRawMessage(message(), [named("receipt.pdf")], AT)
    expect(raw).toContain('name="receipt.pdf"')
    expect(raw).toContain('Content-Disposition: attachment; filename="receipt.pdf"')
    expect(raw).not.toContain("filename*=")
  })
})
