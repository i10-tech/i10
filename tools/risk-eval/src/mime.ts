import {
  MAX_HTML_CHARS,
  MAX_MIME_DEPTH,
  MAX_MIME_PARTS,
  MAX_TEXT_CHARS,
} from "./limits.js"
import { domainOf, htmlToText, truncate } from "./text.js"

/**
 * A defensive RFC 822 / MIME reader.
 *
 * It takes the message as a "binary" string (one char per byte, i.e. latin1
 * decoded) so no byte is lost before the declared charset is known, and it only
 * ever extracts text: nothing is executed, rendered, fetched or resolved. Depth
 * and part counts are bounded, undecodable bytes become replacement characters
 * instead of errors, and an unknown charset falls back to UTF-8.
 */

export interface ParsedMail {
  subject: string
  from?: string
  fromDomain?: string
  year?: number
  text: string
  html?: string
  hasAttachments: boolean
}

type Headers = Map<string, string>

interface Params {
  value: string
  params: Record<string, string>
}

interface Walk {
  parts: number
  plain: string[]
  html: string[]
  attachment: boolean
}

function binaryBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "latin1"))
}

/** Decodes bytes with a declared charset, never throwing. */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
  for (const candidate of [label, "utf-8"]) {
    try {
      // The label comes from the mail; the constructor throws on an unknown one.
      return new TextDecoder(
        candidate as ConstructorParameters<typeof TextDecoder>[0],
      ).decode(bytes)
    } catch {
      // unknown label: try the next candidate
    }
  }
  return Buffer.from(bytes).toString("latin1")
}

/** Header bytes outside an encoded word: UTF-8 if it is valid, else latin1. */
function decodeLoose(s: string): string {
  if (!/[\x80-\xff]/.test(s)) return s
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(binaryBytes(s))
  } catch {
    return s
  }
}

function decodeQuotedPrintable(s: string): Uint8Array {
  const out: number[] = []
  const text = s.replace(/=[ \t]*\r?\n/g, "")
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x3d && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      out.push(c & 0xff)
    }
  }
  return Uint8Array.from(out)
}

/** RFC 2047 encoded words in a header value. */
export function decodeHeader(value: string): string {
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1")
  const decoded = joined.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_whole, charset: string, enc: string, payload: string) => {
      const bytes =
        enc.toLowerCase() === "b"
          ? Uint8Array.from(Buffer.from(payload, "base64"))
          : decodeQuotedPrintable(payload.replace(/_/g, " "))
      return decodeBytes(bytes, charset.replace(/\*.*$/, ""))
    },
  )
  return decodeLoose(decoded).replace(/\s+/g, " ").trim()
}

function splitHeaderBody(raw: string): { head: string; body: string } {
  const blank = /\r?\n\r?\n/.exec(raw)
  if (blank === null) return { head: raw, body: "" }
  return {
    head: raw.slice(0, blank.index),
    body: raw.slice(blank.index + blank[0].length),
  }
}

function parseHeaders(head: string): Headers {
  const headers: Headers = new Map()
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!/^[a-z0-9-]+$/.test(name) || headers.has(name)) continue
    headers.set(name, line.slice(colon + 1).trim())
  }
  return headers
}

function parseParams(header: string | undefined): Params {
  if (header === undefined) return { value: "", params: {} }
  const pieces: string[] = []
  let current = ""
  let quoted = false
  for (const ch of header) {
    if (ch === '"') quoted = !quoted
    if (ch === ";" && !quoted) {
      pieces.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  pieces.push(current)
  const params: Record<string, string> = {}
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=")
    if (eq === -1) continue
    const key = piece.slice(0, eq).trim().toLowerCase()
    params[key] = piece
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "")
  }
  return { value: (pieces[0] ?? "").trim().toLowerCase(), params }
}

function decodeBody(
  body: string,
  headers: Headers,
  charset: string | undefined,
): string {
  const encoding = (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase()
  let bytes: Uint8Array
  if (encoding === "base64") {
    bytes = Uint8Array.from(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"))
  } else if (encoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(body)
  } else {
    bytes = binaryBytes(body)
  }
  return decodeBytes(bytes, charset)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function multipartSegments(body: string, boundary: string): string[] {
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`,
    "g",
  )
  const segments: string[] = []
  let last = -1
  let closed = false
  for (const m of body.matchAll(delimiter)) {
    if (last !== -1) segments.push(body.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1] === "--") {
      closed = true
      break
    }
  }
  if (!closed && last !== -1) segments.push(body.slice(last))
  return segments.map((s) => s.replace(/^\r?\n/, ""))
}

function walk(raw: string, depth: number, state: Walk): void {
  if (state.parts >= MAX_MIME_PARTS || depth > MAX_MIME_DEPTH) return
  state.parts++
  const { head, body } = splitHeaderBody(raw)
  const headers = parseHeaders(head)
  const type = parseParams(headers.get("content-type") ?? "text/plain")
  const disposition = parseParams(headers.get("content-disposition"))

  if (type.value.startsWith("multipart/")) {
    const boundary = type.params.boundary
    if (boundary === undefined || boundary === "" || boundary.length > 200) return
    for (const segment of multipartSegments(body, boundary))
      walk(segment, depth + 1, state)
    return
  }

  const named =
    disposition.params.filename !== undefined || type.params.name !== undefined
  if (disposition.value === "attachment" || named) {
    state.attachment = true
    return
  }
  if (type.value === "text/plain" || type.value === "") {
    state.plain.push(decodeBody(body, headers, type.params.charset))
  } else if (type.value === "text/html") {
    state.html.push(decodeBody(body, headers, type.params.charset))
  } else if (
    !type.value.startsWith("text/") &&
    !(type.value.startsWith("image/") && disposition.value === "inline")
  ) {
    // Any other non-text part (pdf, zip, octet-stream, embedded message) counts.
    state.attachment = true
  }
}

function yearOf(dateHeader: string | undefined): number | undefined {
  if (dateHeader === undefined) return undefined
  for (const m of dateHeader.matchAll(/\b(19[89]\d|20[0-3]\d)\b/g)) {
    const year = Number(m[1])
    if (year >= 1995 && year <= 2035) return year
  }
  return undefined
}

/** Parses one message given as a binary (latin1) string. */
export function parseMessage(raw: string): ParsedMail {
  const { head } = splitHeaderBody(raw)
  const headers = parseHeaders(head)
  const state: Walk = { parts: 0, plain: [], html: [], attachment: false }
  walk(raw, 0, state)

  const htmlJoined = state.html.join("\n\n")
  const plainJoined = state.plain.join("\n\n").trim()
  const html =
    htmlJoined.trim() === "" ? undefined : truncate(htmlJoined, MAX_HTML_CHARS)
  const text = truncate(
    plainJoined !== "" ? plainJoined : html !== undefined ? htmlToText(html) : "",
    MAX_TEXT_CHARS,
  )

  const from = headers.has("from") ? decodeHeader(headers.get("from") ?? "") : undefined
  const parsed: ParsedMail = {
    subject: decodeHeader(headers.get("subject") ?? ""),
    text,
    hasAttachments: state.attachment,
  }
  if (html !== undefined) parsed.html = html
  if (from !== undefined) parsed.from = from
  const fromDomain = domainOf(from)
  if (fromDomain !== undefined) parsed.fromDomain = fromDomain
  const year = yearOf(headers.get("date"))
  if (year !== undefined) parsed.year = year
  return parsed
}
