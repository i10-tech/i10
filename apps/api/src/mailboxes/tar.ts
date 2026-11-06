import { ArchiveError, ByteReader, concat, streamOf } from "./bytes.js"

/**
 * A streaming tar writer and reader (#385).
 *
 * ⚠ TAR, NOT ZIP, FOR WHAT WE WRITE. fflate's streaming `Zip` writes no ZIP64:
 * the end record counts entries in 16 bits and every offset in 32, so a mailbox
 * of more than 65,535 files or 4 GiB comes out as an archive that unzips wrong
 * or not at all - silently, with no error from the writer. A mailbox is one or
 * two files per message, so both limits are ordinary. Tar has neither. We still
 * READ zip (Google Takeout), where fflate's `Unzip` does handle ZIP64.
 *
 * Entries are USTAR, with a pax header for any name too long or not ASCII, which
 * every tar since the nineties reads; macOS, Linux and Windows 11 all open the
 * result.
 */

const BLOCK = 512
/** 8^11 - 1: the largest size the plain octal field holds (just under 8 GiB). */
const MAX_OCTAL_SIZE = 0o77777777777

export interface TarEntry {
  path: string
  size: number
  mtime?: Date
  /** Exactly `size` bytes, however they are cut. */
  body: Uint8Array | AsyncIterable<Uint8Array>
}

const utf8 = new TextEncoder()

const field = (buf: Uint8Array, at: number, width: number, text: string) => {
  const bytes = utf8.encode(text)
  buf.set(bytes.subarray(0, width), at)
}

const octal = (buf: Uint8Array, at: number, width: number, n: number) =>
  field(buf, at, width, n.toString(8).padStart(width - 1, "0"))

function header(name: string, size: number, mtime: Date, typeflag: string): Uint8Array {
  const buf = new Uint8Array(BLOCK)
  field(buf, 0, 100, name)
  octal(buf, 100, 8, 0o644)
  octal(buf, 108, 8, 0)
  octal(buf, 116, 8, 0)
  octal(buf, 124, 12, size)
  octal(buf, 136, 12, Math.floor(mtime.getTime() / 1000))
  buf.fill(0x20, 148, 156) // the checksum field counts as spaces while summing
  buf[156] = typeflag.charCodeAt(0)
  field(buf, 257, 6, "ustar\0")
  field(buf, 263, 2, "00")
  let sum = 0
  for (const b of buf) sum += b
  field(buf, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return buf
}

/** `<len> <key>=<value>\n`, where len counts itself. */
function paxRecord(key: string, value: string): Uint8Array {
  const rest = utf8.encode(` ${key}=${value}\n`)
  let len = rest.byteLength + 1
  while (String(len).length + rest.byteLength !== len)
    len = String(len).length + rest.byteLength
  return concat([utf8.encode(String(len)), rest])
}

const asciiName = (path: string) =>
  /^[\x20-\x7e]{1,100}$/.test(path)
    ? path
    : // The plain name is only a fallback for readers that ignore pax.
      path.replace(/[^\x20-\x7e]/g, "_").slice(-100)

async function* tarBytes(entries: AsyncIterable<TarEntry>): AsyncGenerator<Uint8Array> {
  for await (const entry of entries) {
    if (entry.size > MAX_OCTAL_SIZE) {
      throw new Error(`${entry.path}: too large for a tar entry`)
    }
    const mtime = entry.mtime ?? new Date()
    if (asciiName(entry.path) !== entry.path) {
      const pax = paxRecord("path", entry.path)
      yield header("PaxHeader", pax.byteLength, mtime, "x")
      yield pax
      const pad = (BLOCK - (pax.byteLength % BLOCK)) % BLOCK
      if (pad) yield new Uint8Array(pad)
    }
    yield header(asciiName(entry.path), entry.size, mtime, "0")

    let written = 0
    const pieces =
      entry.body instanceof Uint8Array
        ? [entry.body]
        : (entry.body as AsyncIterable<Uint8Array>)
    for await (const piece of pieces) {
      // ⚠ NEVER EMIT PAST THE DECLARED SIZE: a header that lies shifts every
      // entry after it, and the archive reads as garbage from here on.
      if (written + piece.byteLength > entry.size) {
        throw new Error(`${entry.path}: more than the ${entry.size} bytes declared`)
      }
      written += piece.byteLength
      yield piece
    }
    if (written !== entry.size) {
      throw new Error(
        `${entry.path}: ${written} bytes written of ${entry.size} declared`,
      )
    }
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK
    if (pad) yield new Uint8Array(pad)
  }
  yield new Uint8Array(BLOCK * 2)
}

/** The archive as a stream that produces the next entry only when it is read. */
export function tarStream(
  entries: AsyncIterable<TarEntry>,
): ReadableStream<Uint8Array> {
  return streamOf(tarBytes(entries))
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface TarFile {
  path: string
  size: number
  body: AsyncGenerator<Uint8Array>
}

const text = (block: Uint8Array, at: number, width: number) => {
  const field = block.subarray(at, at + width)
  const end = field.indexOf(0)
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end))
}

function parseSize(block: Uint8Array): number {
  // GNU and pax writers use base-256 for sizes the octal field cannot hold.
  if ((block[124]! & 0x80) !== 0) {
    let n = block[124]! & 0x7f
    for (let i = 125; i < 136; i++) n = n * 256 + block[i]!
    return n
  }
  return parseInt(text(block, 124, 12).trim() || "0", 8)
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!
  return sum === parseInt(text(block, 148, 8).trim() || "-1", 8)
}

function paxFields(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>()
  let at = 0
  while (at < bytes.byteLength) {
    const space = bytes.indexOf(0x20, at)
    const len = Number(new TextDecoder().decode(bytes.subarray(at, space)))
    if (space === -1 || !Number.isInteger(len) || len <= 0) break
    const record = new TextDecoder().decode(bytes.subarray(space + 1, at + len - 1))
    const eq = record.indexOf("=")
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1))
    at += len
  }
  return out
}

/** Header-sized entries (pax, GNU long names) are read whole, up to this. */
const MAX_META = 1024 * 1024

async function readWhole(reader: ByteReader, size: number): Promise<Uint8Array> {
  if (size > MAX_META)
    throw new ArchiveError("archive_invalid", "a tar header entry is too large")
  const parts: Uint8Array[] = []
  for await (const piece of reader.take(size)) parts.push(piece.slice())
  return concat(parts)
}

/**
 * The regular files of a tar, one at a time.
 *
 * ⚠ ONE ENTRY AT A TIME. `body` is read from the same stream as the headers, so
 * it is only good until the next entry is asked for; whatever the caller did not
 * read is skipped here, not left to corrupt the next header.
 */
export async function* tarFiles(reader: ByteReader): AsyncGenerator<TarFile> {
  let longName: string | undefined
  let pax = new Map<string, string>()

  while (true) {
    const block = await reader.readExact(BLOCK)
    if (!block || block.every((b) => b === 0)) return
    if (!checksumOk(block)) {
      throw new ArchiveError("archive_invalid", "the archive is not a valid tar file")
    }

    const flag = String.fromCharCode(block[156] || 0x30)
    const size = parseSize(block)
    const padding = (BLOCK - (size % BLOCK)) % BLOCK

    if (flag === "x" || flag === "g" || flag === "L") {
      const data = await readWhole(reader, size)
      await reader.skip(padding)
      if (flag === "x") pax = paxFields(data)
      else if (flag === "L")
        longName = new TextDecoder().decode(data).replace(/\0.*$/s, "")
      continue
    }

    const prefix = text(block, 345, 155)
    const plain = prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100)
    const path = pax.get("path") ?? longName ?? plain
    const fileSize = pax.has("size") ? Number(pax.get("size")) : size
    pax = new Map()
    longName = undefined

    // Directories, links, devices: nothing to read, only to step over.
    if (flag !== "0" && flag !== "7") {
      await reader.skip(size + padding)
      continue
    }

    let consumed = 0
    const source = reader.take(fileSize)
    const body = (async function* () {
      for await (const piece of source) {
        consumed += piece.byteLength
        yield piece
      }
    })()
    yield { path, size: fileSize, body }
    // Whatever the caller left unread, and the padding after the entry.
    await reader.skip(fileSize - consumed + ((BLOCK - (fileSize % BLOCK)) % BLOCK))
  }
}
