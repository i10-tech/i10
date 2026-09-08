import { messageIdHeader, type OutboundMessage } from "./transport.js"

/**
 * Building a raw RFC 5322 message.
 *
 * ⚠ THIS IS EVERY SEND, NOT THE ATTACHMENT EXCEPTION IT WAS BUILT AS. It used
 * to run only when `Content.Simple` could not express a file, on the reasoning
 * that Simple is less code to be wrong in and lets SES handle the encoding.
 * That reasoning had one false premise: SES REJECTS A `Message-ID` HEADER ON
 * SIMPLE CONTENT — `BadRequestException: Header <Message-ID> is not supported`,
 * which is what the first mail this system ever sent came back with.
 *
 * ⚠ AND SES THEN OVERWRITES THAT HEADER, SO THE MOVE DID NOT ACHIEVE ITS AIM.
 * The SendRawEmail reference says SES applies its own `Message-ID` and `Date`
 * and discards a caller's; confirmed on the wire, and again with a raw message
 * sent straight from the AWS CLI. Raw is still the single path — attachments
 * need it, and one path beats two — but the duplicate mitigation it was reached
 * for is absent on every send we currently make. See send/transport.ts.
 *
 * ⚠ EVERY LINE ENDS CRLF, INCLUDING THE BLANK ONES. A bare LF makes the message
 * technically malformed; some receivers accept it, some reject it, and the ones
 * that accept it may still fail DKIM verification because the signature was
 * computed over canonicalised CRLF. A "sometimes lands in spam" bug is far
 * worse to chase than a rejection.
 *
 * ⚠ AND EVERY BODY PART IS BASE64, INCLUDING THE TEXT. Quoted-printable would
 * be more readable on the wire and needs soft line breaks, escaping, and a rule
 * about trailing whitespace — three chances to corrupt a customer's message.
 * Base64 has none, and it makes a boundary collision impossible: the boundary
 * is derived from the message id, and no base64 alphabet can contain it.
 */

/** Attachments as the contract accepts them, after validation. */
export interface MimeAttachment {
  filename: string
  content?: string | undefined
  content_type?: string | undefined
}

const CRLF = "\r\n"

/**
 * ⚠ HEADERS WE OWN. A caller-supplied copy of any of these is dropped: `From`
 * and `To` decide who the mail is from and to, `Message-ID` is ours to derive
 * from the row id rather than the caller's to choose, and `Content-Type` would
 * contradict the structure built below. `Bcc` is absent for a different reason —
 * see `buildRawMessage`.
 */
const OWNED = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
])

/**
 * The complete message, ready for SES's `Content.Raw`.
 *
 * ⚠ NO `Bcc` HEADER IS WRITTEN, EVER. Blind copy is blind because the header is
 * absent from what recipients receive; SES takes the actual recipient list from
 * `Destination`, so writing one here would deliver the same mail and disclose
 * every hidden recipient to everyone else on it.
 */
export function buildRawMessage(
  message: OutboundMessage,
  attachments: readonly MimeAttachment[],
  now: Date = new Date(),
): string {
  const headers: string[] = [
    `From: ${formatAddressList([message.from])}`,
    `To: ${formatAddressList(message.to)}`,
  ]

  if (message.cc.length) headers.push(`Cc: ${formatAddressList(message.cc)}`)
  if (message.replyTo.length) {
    headers.push(`Reply-To: ${formatAddressList(message.replyTo)}`)
  }

  headers.push(
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    // ⚠ WRITTEN, AND THEN OVERWRITTEN BY SES — both this and `Date` above.
    // Emitted anyway: it costs nothing, and it is what a relay we run ourselves
    // would carry, where a retry of an at-least-once send really is collapsed by
    // receivers rather than shown twice.
    `Message-ID: ${messageIdHeader(message.id, message.from)}`,
    "MIME-Version: 1.0",
  )

  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (OWNED.has(name.toLowerCase())) continue
    // A header value cannot span lines here: a CR or LF in one is header
    // injection, and folding it correctly is not worth the risk when the value
    // came from a request body.
    headers.push(`${name}: ${String(value).replace(/[\r\n]+/g, " ")}`)
  }

  const body = bodyPart(message)

  /**
   * ⚠ NO `multipart/mixed` WHERE THERE IS NOTHING TO MIX. `bodyPart` already
   * carries its own `Content-Type` — a single part, or a `multipart/alternative`
   * when there is both text and html — so with no attachments it follows the
   * headers directly and the message ends one level shallower.
   *
   * Wrapping it anyway would be legal and would work, but it would announce a
   * multipart message to every client for the sake of one part, and a
   * plain-text send would arrive structurally indistinguishable from one
   * carrying a file.
   */
  if (attachments.length === 0) return [...headers, body].join(CRLF)

  const boundary = boundaryFor(message.id, "mixed")
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)

  const parts = [body, ...attachments.map(attachmentPart)]

  return [
    headers.join(CRLF),
    "",
    // Shown by clients too old to understand MIME at all. It is inert, and it
    // is what stops such a client rendering the raw base64.
    "This is a message in MIME format.",
    "",
    ...parts.map((part) => `--${boundary}${CRLF}${part}`),
    `--${boundary}--`,
    "",
  ].join(CRLF)
}

/**
 * The text and html halves.
 *
 * Two bodies become a nested `multipart/alternative` so a client picks one; a
 * single body needs no nesting, and adding it anyway would make a plain-text
 * message with one attachment three levels deep for no reason.
 */
function bodyPart(message: OutboundMessage): string {
  const text = message.text ? textPart("text/plain", message.text) : null
  const html = message.html ? textPart("text/html", message.html) : null

  if (text && html) {
    const boundary = boundaryFor(message.id, "alt")
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      // ⚠ PLAIN FIRST, HTML SECOND, AND THE ORDER IS THE MEANING. RFC 2046 says
      // the last part is the richest; reversing them shows plain text to every
      // client that understands html.
      `--${boundary}${CRLF}${text}`,
      `--${boundary}${CRLF}${html}`,
      `--${boundary}--`,
      "",
    ].join(CRLF)
  }

  return text ?? html ?? textPart("text/plain", "")
}

function textPart(contentType: string, body: string): string {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(body, "utf8").toString("base64")),
    "",
  ].join(CRLF)
}

function attachmentPart(attachment: MimeAttachment): string {
  return [
    `Content-Type: ${attachment.content_type ?? "application/octet-stream"}; ` +
      `name="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "",
    // ⚠ RE-WRAPPED, NOT RE-ENCODED. The caller already sent base64 and the
    // contract validated it; decoding it to encode it again would double the
    // memory a ten-megabyte attachment costs and could only ever produce the
    // same bytes.
    wrap((attachment.content ?? "").replace(/\s+/g, "")),
    "",
  ].join(CRLF)
}

/**
 * ⚠ DERIVED FROM THE MESSAGE ID RATHER THAN RANDOM, WHICH MAKES A RETRY
 * BYTE-IDENTICAL. The send path is at-least-once, and a duplicate is collapsed
 * by receivers on the Message-ID; a random boundary would not break that, but it
 * would make two copies of "the same" message differ, which is exactly the kind
 * of difference that turns a silent dedupe into a visible second email in some
 * clients.
 *
 * It cannot collide with content either: every part is base64, and `=_` is not
 * in the base64 alphabet.
 */
const boundaryFor = (id: string, kind: string) => `----=_i10_${kind}_${id}`

/** RFC 2045 caps an encoded line at 76 characters. */
function wrap(base64: string): string {
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76))
  return lines.join(CRLF)
}

const ASCII = /^[\x20-\x7e]*$/

/**
 * RFC 2047 encoding for a header value that is not plain ASCII.
 *
 * ⚠ A RAW UTF-8 SUBJECT IS NOT LEGAL IN A HEADER AND FAILS QUIETLY. Some
 * receivers render it, some show mojibake, and some drop the header — so a
 * subject with an emoji or an accent in it is a bug that only appears for some
 * of the recipients.
 */
export function encodeWord(value: string): string {
  if (ASCII.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

/**
 * Formats addresses for a header, encoding only the display name.
 *
 * ⚠ THE ADDRESS ITSELF IS NEVER ENCODED. `=?UTF-8?B?...?=` is legal in a
 * display name and meaningless in an addr-spec — encoding the whole string
 * would produce a header no receiver can route.
 */
export function formatAddressList(addresses: readonly string[]): string {
  return addresses.map(formatAddress).join(", ")
}

function formatAddress(address: string): string {
  const match = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(address)
  if (!match) return address.trim()

  const [, name, addr] = match
  if (!name) return `<${addr}>`

  // ⚠ UNWRAPPED ONLY IF IT IS WRAPPED. Stripping a leading OR trailing quote
  // independently would eat the closing quote of a name that merely ends in
  // one — `Bob "The Sender"` — and leave an unbalanced quote in the header,
  // which swallows the address that follows it.
  const bare = /^".*"$/s.test(name) ? name.slice(1, -1) : name

  const display = ASCII.test(bare)
    ? // Quoted rather than bare: a comma or a colon in an unquoted display name
      // would be read as an address separator.
      `"${bare.replace(/["\\]/g, "\\$&")}"`
    : encodeWord(bare)

  return `${display} <${addr}>`
}
