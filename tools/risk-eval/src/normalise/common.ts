import { open, stat } from "node:fs/promises"
import {
  MAX_FILE_BYTES,
  MAX_HTML_CHARS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_TEXT_CHARS,
} from "../limits.js"
import { detectLanguage } from "../lang.js"
import { parseMessage } from "../mime.js"
import type { DatasetDef } from "../registry.js"
import type { Label, Mail } from "../schema.js"
import { sha256Hex, truncate } from "../text.js"

/** What a normaliser needs: the dataset and where its files were downloaded. */
export interface NormaliseContext {
  dataset: DatasetDef
  dir: string
  /** Counters the caller reports; a normaliser increments `skipped` on junk. */
  stats: { skipped: number }
}

export type Normaliser = (ctx: NormaliseContext) => AsyncGenerator<Mail>

export interface MailFields {
  subject: string
  text: string
  html?: string | undefined
  year?: number | undefined
  fromDomain?: string | undefined
  hasAttachments?: boolean | undefined
}

/** Builds the one record shape; `sourceKey` makes the id stable and unique. */
export function toMail(
  dataset: DatasetDef,
  sourceKey: string,
  label: Label,
  originalLabel: string | undefined,
  fields: MailFields,
): Mail {
  const text = truncate(fields.text, MAX_TEXT_CHARS)
  const mail: Mail = {
    id: `${dataset.id}:${sha256Hex(sourceKey).slice(0, 16)}`,
    dataset: dataset.id,
    label,
    subject: truncate(fields.subject, 1000),
    text,
    lang: detectLanguage(`${fields.subject}\n${text}`),
    synthetic: dataset.synthetic,
  }
  if (originalLabel !== undefined) mail.original_label = originalLabel
  if (fields.html !== undefined) mail.html = truncate(fields.html, MAX_HTML_CHARS)
  if (fields.year !== undefined) mail.year = fields.year
  if (fields.fromDomain !== undefined) mail.from_domain = fields.fromDomain
  if (fields.hasAttachments !== undefined) mail.has_attachments = fields.hasAttachments
  return mail
}

/** Reads a whole file as a binary string, refusing anything over the cap. */
export async function readBinary(
  path: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<string> {
  const info = await stat(path)
  if (info.size > maxBytes)
    throw new Error(`${path} is ${info.size} bytes, over the ${maxBytes} limit`)
  return Buffer.from(await Bun.file(path).arrayBuffer()).toString("latin1")
}

/** Reads a whole UTF-8 text file (invalid bytes become U+FFFD), capped. */
export async function readText(
  path: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<string> {
  const info = await stat(path)
  if (info.size > maxBytes)
    throw new Error(`${path} is ${info.size} bytes, over the ${maxBytes} limit`)
  return Bun.file(path).text()
}

/** Reads at most MAX_RAW_MESSAGE_BYTES of one message file, as a binary string. */
export async function readMessageFile(path: string): Promise<string> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(MAX_RAW_MESSAGE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_RAW_MESSAGE_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString("latin1")
  } finally {
    await handle.close()
  }
}

/** Parses one raw message into mail fields; a parse failure is the caller's skip. */
export function fieldsFromRaw(raw: string): MailFields {
  const parsed = parseMessage(
    raw.length > MAX_RAW_MESSAGE_BYTES ? raw.slice(0, MAX_RAW_MESSAGE_BYTES) : raw,
  )
  return {
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    year: parsed.year,
    fromDomain: parsed.fromDomain,
    hasAttachments: parsed.hasAttachments,
  }
}
