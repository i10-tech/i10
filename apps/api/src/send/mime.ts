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
    addressHeader("From", [message.from]),
    addressHeader("To", message.to),
  ]

  if (message.cc.length) headers.push(addressHeader("Cc", message.cc))
  if (message.replyTo.length) {
    headers.push(addressHeader("Reply-To", message.replyTo))
  }

  headers.push(
    foldUnstructured("Subject", encodeWord(message.subject)),
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
    // ⚠ THE CALLER'S LINE BREAKS ARE STILL FLATTENED FIRST, AND THEN WE FOLD.
    // A CR or LF arriving in a header value is header injection — the caller
    // could otherwise append headers, or a whole second MIME part, to their own
    // message — so it collapses to a space before anything else touches it.
    // `foldUnstructured` reintroduces line breaks only as RFC 5322 folding
    // whitespace, which a parser unfolds back to the single logical line.
    headers.push(foldUnstructured(name, String(value).replace(/[\r\n]+/g, " ")))
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

/**
 * ⚠ A NON-ASCII FILENAME IS NOT LEGAL RAW IN A HEADER, AND IT USED TO GO IN RAW.
 * `réçu.pdf` put UTF-8 bytes straight into `Content-Type` and
 * `Content-Disposition`. That is not RFC 5322 — headers are ASCII — and the
 * damage was the quiet kind: some clients rendered it, some showed mojibake, and
 * the message needed an SMTPUTF8-capable path to leave at all.
 *
 * ⚠ IT BECAME LOUD WHEN THE DIRECT ROUTE MOVED TO upyo, WHICH IS HOW IT WAS
 * FOUND. upyo inspects the bytes and classifies a message with non-ASCII headers
 * as `utf8`, then refuses to send it to a server that does not advertise
 * SMTPUTF8 — a permanent failure, on the direct route only. A customer's
 * attachment named in their own language would have failed or succeeded
 * depending on which MTA carried it, which is precisely the route-visible
 * difference this whole design exists to prevent.
 *
 * ⚠ TWO PARAMETERS, TWO MECHANISMS, BECAUSE THE HEADERS DIFFER. `name=` on
 * `Content-Type` is the deprecated one and takes an RFC 2047 encoded-word, which
 * is what clients that still read it expect. `filename*=` on
 * `Content-Disposition` is RFC 2231 — `UTF-8''` followed by percent-encoding —
 * which is the actual standard for a parameter value that is not ASCII, and the
 * one every current client prefers.
 *
 * ⚠ AND AN ASCII FILENAME TAKES NEITHER, BYTE FOR BYTE AS BEFORE. The common
 * case is unchanged, so this cannot regress a message that works today.
 */
function attachmentPart(attachment: MimeAttachment): string {
  const { filename } = attachment
  const ascii = ASCII.test(filename)

  return [
    `Content-Type: ${attachment.content_type ?? "application/octet-stream"}; ` +
      `name="${ascii ? filename : encodeWord(filename)}"`,
    "Content-Transfer-Encoding: base64",
    ascii
      ? `Content-Disposition: attachment; filename="${filename}"`
      : `Content-Disposition: attachment; filename*=UTF-8''${rfc2231(filename)}`,
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
 * RFC 2231 percent-encoding for a header PARAMETER that is not plain ASCII.
 *
 * ⚠ NOT `encodeURIComponent` ALONE. It leaves `'`, `(`, `)` and `*` unescaped,
 * and all four are outside RFC 2231's `attr-char` set — `*` and `'` especially,
 * since they are the delimiters of the `filename*=UTF-8''…` syntax itself. A
 * filename containing an apostrophe would otherwise terminate the charset
 * section early and produce a parameter every client reads differently.
 */
function rfc2231(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * RFC 5322 §2.1.1: 78 octets per line is the recommendation, 998 the hard limit.
 *
 * ⚠ 998 IS NOT A STYLE PREFERENCE, IT IS THE POINT AT WHICH A MESSAGE STOPS
 * BEING SENDABLE. `To:` accepts 50 addresses of up to 320 characters, so an
 * unfolded recipient list reaches sixteen kilobytes on ONE LINE — and did, until
 * this existed. SES accepted those messages and silently did whatever it does;
 * the direct route's validator refuses them outright, so the same send worked or
 * failed depending on the route, which is the one difference this design is
 * supposed to make impossible.
 *
 * We fold at 78 rather than 998 because that is what the RFC recommends and what
 * every other mail agent emits; the hard limit is what makes it mandatory.
 */
const FOLD_AT = 78

/**
 * RFC 2047 encoding for a header value that is not plain ASCII.
 *
 * ⚠ A RAW UTF-8 SUBJECT IS NOT LEGAL IN A HEADER AND FAILS QUIETLY. Some
 * receivers render it, some show mojibake, and some drop the header — so a
 * subject with an emoji or an accent in it is a bug that only appears for some
 * of the recipients.
 *
 * ⚠ AND AN ENCODED-WORD IS CAPPED AT 75 CHARACTERS, WHICH ONE LONG SUBJECT
 * BLOWS PAST. RFC 2047 §2 sets the limit, and a single encoded-word cannot be
 * folded because folding needs whitespace and there is none inside one. A
 * 200-character accented subject produced one 545-character word: illegal,
 * unfoldable, and — on the direct route — unsendable.
 *
 * The fix is the one the RFC provides: adjacent encoded-words separated by
 * whitespace are concatenated WITHOUT that whitespace, so splitting is lossless
 * and the spaces between them become the fold points.
 *
 * ⚠ SPLIT ON CODE POINTS, NEVER ON BYTES. `=?UTF-8?B?` chunks are decoded
 * independently, so a multi-byte character cut across two words decodes to
 * replacement characters in both. `Array.from` iterates code points, which is
 * what makes the 45-byte budget safe to fill greedily.
 */
export function encodeWord(value: string): string {
  if (ASCII.test(value)) return value

  // `=?UTF-8?B?` + `?=` is 12 characters of overhead against a 75-character
  // limit, leaving 63 for base64 — rounded down to 60, the nearest multiple of
  // four, which is 45 bytes of UTF-8 per word.
  const MAX_BYTES = 45

  const words: string[] = []
  let chunk: string[] = []
  let bytes = 0

  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > MAX_BYTES && chunk.length > 0) {
      words.push(chunk.join(""))
      chunk = []
      bytes = 0
    }
    chunk.push(char)
    bytes += size
  }
  if (chunk.length > 0) words.push(chunk.join(""))

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join(" ")
}

/**
 * A header whose value is text, folded onto continuation lines if it is long.
 *
 * ⚠ FOLDING WHITESPACE IS THE SPACE THAT WAS ALREADY THERE, NOT AN ADDED ONE.
 * RFC 5322 unfolding removes the CRLF before leading whitespace and keeps that
 * whitespace, so breaking at a space and starting the next line with one space
 * reproduces the original value exactly. Inserting an extra space instead —
 * which is the easy mistake — silently rewrites every long subject a customer
 * sends.
 *
 * ⚠ A RUN OF SPACES IS NEVER A FOLD POINT, FOR THE SAME REASON. Breaking inside
 * `"a  b"` would collapse the run to a single space on unfold. Rare, but it is
 * the customer's text, and quietly editing it is not ours to do.
 *
 * ⚠ AND A SINGLE TOKEN LONGER THAN THE LIMIT IS EMITTED WHOLE. There is no
 * legal way to fold inside one — a 1200-character URL in a `List-Unsubscribe`
 * genuinely cannot be sent — so this does not mangle it into something that
 * looks sendable. The transport's validator then rejects it, which is the
 * honest answer rather than a header the receiver silently truncates.
 */
function foldUnstructured(name: string, value: string): string {
  const header = `${name}: ${value}`
  if (Buffer.byteLength(header, "utf8") <= FOLD_AT) return header

  const lines: string[] = []
  let line = `${name}:`

  for (const token of value.split(" ")) {
    const candidate = `${line} ${token}`
    // Never fold at an empty token: that is a run of spaces, and the run is the
    // customer's.
    if (
      token !== "" &&
      line !== `${name}:` &&
      Buffer.byteLength(candidate, "utf8") > FOLD_AT
    ) {
      lines.push(line)
      line = ` ${token}`
    } else {
      line = candidate
    }
  }
  lines.push(line)

  return lines.join(CRLF)
}

/**
 * An address-list header, folded between addresses rather than inside one.
 *
 * ⚠ THE COMMA GOES AT THE END OF THE LINE, NOT THE START OF THE NEXT. Both
 * unfold to the same value, but every mail agent in existence emits it this way
 * and a `Cc:` that does not is the kind of difference a spam filter notices
 * without ever telling you which one it was.
 *
 * ⚠ AND ONE ADDRESS IS NEVER SPLIT. A display name can carry spaces, so folding
 * this as unstructured text would break a line inside `"Some Long Name" <a@b>`
 * — legal, but it puts the fold in the middle of a phrase where some parsers
 * handle it and some do not.
 */
function addressHeader(name: string, addresses: readonly string[]): string {
  const header = `${name}: ${formatAddressList(addresses)}`
  if (Buffer.byteLength(header, "utf8") <= FOLD_AT) return header

  const formatted = addresses.map(formatAddress)
  const lines: string[] = []
  let line = `${name}:`

  formatted.forEach((address, index) => {
    const piece = index === formatted.length - 1 ? address : `${address},`
    const candidate = `${line} ${piece}`
    if (line !== `${name}:` && Buffer.byteLength(candidate, "utf8") > FOLD_AT) {
      lines.push(line)
      line = ` ${piece}`
    } else {
      line = candidate
    }
  })
  lines.push(line)

  return lines.join(CRLF)
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
