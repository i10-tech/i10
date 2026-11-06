import { Unzip, UnzipInflate } from "fflate"
import { ArchiveError, ByteBuilder, ByteReader, streamOf } from "./bytes.js"
import { splitMbox } from "./mbox.js"
import { tarFiles, type TarEntry } from "./tar.js"

/**
 * Mailbox archives, both directions (#385).
 *
 * WRITE: a tar (see tar.ts for why not a zip), gzipped by the caller. Per
 * message two entries, the metadata first so a reader has it when the message
 * arrives, and `export.json` last:
 *
 *   Inbox/0000001.meta.json    { folder: ["Inbox"], role, keywords, received_at }
 *   Inbox/0000001.eml          the message, byte for byte
 *   export.json                the end marker: counts, and every folder
 *
 * READ: that, and what customers actually have - a Google Takeout (zip or tgz of
 * `.mbox` files), a folder of `.eml` files, or a bare mbox.
 *
 * ⚠ NOTHING HERE HOLDS MORE THAN ONE MESSAGE. Entries are read as streams, an
 * mbox is split as it flows, and a message is assembled in a builder that
 * refuses to pass `maxMessageBytes`. The archive as a whole is only ever a
 * stream, so its size is a policy (`maxArchiveBytes`), not a memory figure.
 */

export interface ArchiveLimits {
  /** The upload itself. */
  maxArchiveBytes: number
  /** What it unpacks to, so a small file of zeros cannot run a job for days. */
  maxUnpackedBytes: number
  /** One message. Stalwart refuses more: `Email.maxMessageSize` is 50 MB. */
  maxMessageBytes: number
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/**
 * ⚠ 4 GiB BECAUSE THE UPLOAD IS ONE PRESIGNED `PUT`, and R2 takes at most
 * 4.995 GiB in one. A bigger mailbox exports fine (the export is a multipart
 * write) but has to be split before it comes back in; Google Takeout splits
 * its own archives at 2 GB by default.
 */
export const LIMITS: ArchiveLimits = {
  maxArchiveBytes: 4 * GIB,
  maxUnpackedBytes: 32 * GIB,
  maxMessageBytes: 50 * MIB,
}

export interface ImportMessage {
  /** The folder as a path of names. Empty: the Inbox. */
  folder: string[]
  role: string | null
  content: Uint8Array
  keywords: Record<string, boolean>
  receivedAt: string | undefined
  /** Where it came from, for an error message. */
  entry: string
}

export interface ExportManifest {
  version: 1
  exported_at: string
  mailbox: string
  total_messages: number
  folders: { path: string[]; role: string | null; total: number }[]
}

interface MessageMeta {
  folder: string[]
  role: string | null
  keywords: Record<string, boolean>
  received_at: string | null
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** A folder name as one path segment, safe to extract on any machine. */
const segment = (name: string) => {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim()
  return safe === "" || safe === "." || safe === ".." ? "_" : safe
}

export function messagePaths(folder: string[], sequence: number) {
  const stem = `${(folder.length ? folder : ["INBOX"]).map(segment).join("/")}/${String(sequence).padStart(7, "0")}`
  return { eml: `${stem}.eml`, meta: `${stem}.meta.json` }
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

export function metaEntry(path: string, meta: MessageMeta): TarEntry {
  const body = json(meta)
  return { path, size: body.byteLength, body }
}

export function manifestEntry(manifest: ExportManifest): TarEntry {
  const body = json(manifest)
  return { path: "export.json", size: body.byteLength, body }
}

// ── Reading ─────────────────────────────────────────────────────────────────

interface Entry {
  name: string
  /** `null` for a zip written as a stream, which does not know until the end. */
  size: number | null
  chunks: AsyncIterable<Uint8Array>
}

/** Pieces a zip is fed in: what bounds a deflate bomb's burst of output. */
const FEED_BYTES = 32 * 1024

async function* zipEntries(reader: ByteReader): AsyncGenerator<Entry> {
  interface Pending {
    name: string
    size: number | null
    queue: Uint8Array[]
    ended: boolean
    failure?: Error
  }
  const unzip = new Unzip()
  unzip.register(UnzipInflate)

  const found: Pending[] = []
  unzip.onfile = (file) => {
    const pending: Pending = {
      name: file.name,
      size: file.originalSize ?? null,
      queue: [],
      ended: false,
    }
    file.ondata = (error, data, final) => {
      if (error) pending.failure = error
      else {
        if (data.byteLength) pending.queue.push(data)
        if (final) pending.ended = true
      }
    }
    // ⚠ STARTED AT ONCE. An entry that is not started is buffered whole inside
    // fflate until somebody does, which is the memory this is here to avoid.
    file.start()
    found.push(pending)
  }

  const source = reader.rest()
  let exhausted = false
  /** Feeds the unzipper the next piece; `false` once the archive is over. */
  async function feed(): Promise<boolean> {
    if (exhausted) return false
    const next = await source.next()
    try {
      if (next.done) {
        exhausted = true
        unzip.push(new Uint8Array(0), true)
        return false
      }
      for (let at = 0; at < next.value.byteLength; at += FEED_BYTES) {
        unzip.push(next.value.subarray(at, at + FEED_BYTES), false)
      }
      return true
    } catch (error) {
      if (error instanceof ArchiveError) throw error
      throw new ArchiveError("archive_invalid", `the zip is damaged: ${String(error)}`)
    }
  }

  async function* entryChunks(pending: Pending): AsyncGenerator<Uint8Array> {
    while (true) {
      while (pending.queue.length) yield pending.queue.shift()!
      if (pending.failure) {
        throw new ArchiveError(
          "archive_invalid",
          `the zip is damaged: ${pending.failure.message}`,
        )
      }
      if (pending.ended) return
      if (!(await feed()) && !pending.ended && !pending.queue.length) {
        throw new ArchiveError(
          "archive_invalid",
          "the zip ends in the middle of an entry",
        )
      }
    }
  }

  while (true) {
    const next = found.shift()
    if (!next) {
      if (!(await feed())) return
      continue
    }
    const chunks = entryChunks(next)
    yield { name: next.name, size: next.size, chunks }
    // Whatever the caller left unread has to be consumed to reach the next entry.
    for await (const unread of chunks) void unread
  }
}

async function* tarEntries(reader: ByteReader): AsyncGenerator<Entry> {
  for await (const file of tarFiles(reader)) {
    yield { name: file.path, size: file.size, chunks: file.body }
  }
}

const isZip = (head: Uint8Array) =>
  head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
const isGzip = (head: Uint8Array) => head[0] === 0x1f && head[1] === 0x8b
const isTar = (head: Uint8Array) =>
  head.byteLength >= 512 &&
  new TextDecoder().decode(head.subarray(257, 262)) === "ustar"
const isMbox = (head: Uint8Array) =>
  new TextDecoder().decode(head.subarray(0, 5)) === "From "

async function* openEntries(
  source: ReadableStream<Uint8Array>,
  limits: ArchiveLimits,
): AsyncGenerator<Entry> {
  let reader = new ByteReader(
    source,
    limits.maxArchiveBytes,
    () =>
      new ArchiveError(
        "archive_too_large",
        `the archive is over ${limits.maxArchiveBytes / GIB} GiB; split it and import the parts`,
      ),
  )

  if (isGzip(await reader.peek(2))) {
    reader = new ByteReader(
      streamOf(reader.rest()).pipeThrough(new DecompressionStream("gzip")),
      limits.maxUnpackedBytes,
      () =>
        new ArchiveError(
          "archive_too_large",
          `the archive unpacks to more than ${limits.maxUnpackedBytes / GIB} GiB`,
        ),
    )
  }

  const head = await reader.peek(512)
  if (isZip(head)) yield* zipEntries(reader)
  else if (isTar(head)) yield* tarEntries(reader)
  else if (isMbox(head)) yield { name: "INBOX.mbox", size: null, chunks: reader.rest() }
  else {
    throw new ArchiveError(
      "archive_invalid",
      "that is not a zip, tar, tar.gz or mbox file",
    )
  }
}

/** Date header to an ISO instant, from the first lines of a message. */
function receivedAtOf(message: Uint8Array): string | undefined {
  const headers = new TextDecoder().decode(message.subarray(0, 16 * 1024))
  const match = /^date:[ \t]*(.+)$/im.exec(headers)
  if (!match) return undefined
  const parsed = new Date(match[1]!.trim())
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string")

function parseJson(bytes: Uint8Array, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof value === "object" && value !== null)
      return value as Record<string, unknown>
  } catch {
    // Falls through to the error below.
  }
  throw new ArchiveError("archive_invalid", `${name} is not valid JSON`)
}

function parseMeta(bytes: Uint8Array, name: string): MessageMeta {
  const raw = parseJson(bytes, name)
  const keywords = raw.keywords
  if (
    !isStrings(raw.folder) ||
    typeof keywords !== "object" ||
    keywords === null ||
    !Object.values(keywords).every((v) => typeof v === "boolean")
  ) {
    throw new ArchiveError("archive_invalid", `${name} does not describe a message`)
  }
  return {
    folder: raw.folder,
    role: typeof raw.role === "string" ? raw.role : null,
    keywords: keywords as Record<string, boolean>,
    received_at: typeof raw.received_at === "string" ? raw.received_at : null,
  }
}

function parseManifest(bytes: Uint8Array): ExportManifest {
  const raw = parseJson(bytes, "export.json")
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.folders) ||
    typeof raw.total_messages !== "number"
  ) {
    throw new ArchiveError(
      "archive_invalid",
      "export.json is not an i10 export manifest",
    )
  }
  return raw as unknown as ExportManifest
}

const SKIPPED = /(^|\/)(__MACOSX\/|\.DS_Store$|\._)/

export type ImportItem =
  | { type: "message"; message: ImportMessage }
  | { type: "manifest"; manifest: ExportManifest }

/**
 * An archive's messages, one at a time, in the order they appear.
 *
 * ⚠ AN i10 EXPORT THAT ENDS EARLY IS AN ERROR, NOT A SHORT IMPORT. A tar has no
 * central directory, so a truncated one reads cleanly up to where it stops; the
 * trailing `export.json` is what says it was all there.
 */
export async function* readArchive(
  source: ReadableStream<Uint8Array>,
  limits: ArchiveLimits = LIMITS,
): AsyncGenerator<ImportItem> {
  const tooLarge = (name: string) =>
    new ArchiveError(
      "message_too_large",
      `${name} is over ${limits.maxMessageBytes / MIB} MB, the most a mailbox accepts`,
    )
  const small = async (entry: Entry, max: number) => {
    const into = new ByteBuilder(
      max,
      () => new ArchiveError("archive_invalid", `${entry.name} is too large`),
    )
    for await (const piece of entry.chunks) into.append(piece)
    return into.take()
  }

  let pendingMeta: { stem: string; meta: MessageMeta } | null = null
  let sawMeta = false
  let seen = 0
  let manifest: ExportManifest | null = null

  for await (const entry of openEntries(source, limits)) {
    const name = entry.name.replace(/^\.\//, "")
    if (name.endsWith("/") || SKIPPED.test(name)) continue
    const lower = name.toLowerCase()
    const parts = name.split("/")
    const base = parts.at(-1)!

    if (name === "export.json") {
      manifest = parseManifest(await small(entry, MIB))
      yield { type: "manifest", manifest }
    } else if (lower.endsWith(".meta.json")) {
      sawMeta = true
      pendingMeta = {
        stem: name.slice(0, -".meta.json".length),
        meta: parseMeta(await small(entry, 64 * 1024), name),
      }
    } else if (lower.endsWith(".eml")) {
      if (entry.size !== null && entry.size > limits.maxMessageBytes)
        throw tooLarge(name)
      const into = new ByteBuilder(limits.maxMessageBytes, () => tooLarge(name))
      for await (const piece of entry.chunks) into.append(piece)
      const content = into.take()
      if (content.byteLength === 0) continue

      const meta =
        pendingMeta?.stem === name.slice(0, -".eml".length) ? pendingMeta.meta : null
      pendingMeta = null
      seen++
      yield {
        type: "message",
        message: {
          folder: meta?.folder ?? parts.slice(0, -1),
          role: meta?.role ?? null,
          content,
          keywords: meta?.keywords ?? { $seen: true },
          receivedAt: meta?.received_at ?? receivedAtOf(content),
          entry: name,
        },
      }
    } else if (lower.endsWith(".mbox")) {
      const folder = [base.slice(0, -".mbox".length) || "INBOX"]
      for await (const content of splitMbox(entry.chunks, limits.maxMessageBytes)) {
        seen++
        yield {
          type: "message",
          message: {
            folder,
            role: null,
            content,
            keywords: { $seen: true },
            receivedAt: receivedAtOf(content),
            entry: name,
          },
        }
      }
    }
    // Anything else (a Takeout's html, json, labels) is not mail.
  }

  if ((sawMeta && !manifest) || (manifest && seen < manifest.total_messages)) {
    throw new ArchiveError(
      "archive_incomplete",
      manifest
        ? `the archive holds ${seen} of the ${manifest.total_messages} messages it lists`
        : "the archive ends before its export.json; the upload was cut short",
    )
  }
}
