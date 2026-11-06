import { ArchiveError, ByteBuilder } from "./bytes.js"

/**
 * A streaming mbox splitter (#385): messages out one at a time, from a file
 * that may be gigabytes (a Google Takeout is one `.mbox` per label).
 *
 * ⚠ BYTES, NEVER STRINGS. The first attempt decoded the whole file as UTF-8 and
 * re-encoded each message, which damages every 8-bit body and every message in
 * another charset. This works on the bytes as they are, and the one change it
 * makes - undoing mboxrd's `>From ` quoting - is the format's own.
 *
 * Memory is the one message being assembled (capped at `maxMessage`) plus the
 * line it is in the middle of.
 */

const FROM = new TextEncoder().encode("From ")

const startsWith = (line: Uint8Array, at: number) =>
  FROM.every((byte, i) => line[at + i] === byte)

type LineKind = "separator" | "quoted" | "text"

function classify(line: Uint8Array): LineKind {
  if (startsWith(line, 0)) return "separator"
  // mboxrd: any number of `>` before `From ` marks a line that was escaped.
  let quotes = 0
  while (line[quotes] === 0x3e) quotes++
  return quotes > 0 && startsWith(line, quotes) ? "quoted" : "text"
}

/** mbox is LF-delimited by construction; a message on the wire is CRLF. */
export function toCrlf(bytes: Uint8Array): Uint8Array {
  let bare = 0
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) {
    if (i === 0 || bytes[i - 1] !== 13) bare++
  }
  if (bare === 0) return bytes
  const out = new Uint8Array(bytes.byteLength + bare)
  let at = 0
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 10 && (i === 0 || bytes[i - 1] !== 13)) out[at++] = 13
    out[at++] = bytes[i]!
  }
  return out
}

/** The blank line mbox writes before each separator is not part of the message. */
function trimSeparator(bytes: Uint8Array): Uint8Array {
  const n = bytes.byteLength
  if (
    n >= 4 &&
    bytes[n - 1] === 10 &&
    bytes[n - 2] === 13 &&
    bytes[n - 3] === 10 &&
    bytes[n - 4] === 13
  ) {
    return bytes.subarray(0, n - 2)
  }
  if (n >= 2 && bytes[n - 1] === 10 && bytes[n - 2] === 10)
    return bytes.subarray(0, n - 1)
  return bytes
}

export async function* splitMbox(
  chunks: AsyncIterable<Uint8Array>,
  maxMessage: number,
): AsyncGenerator<Uint8Array> {
  const tooLarge = () =>
    new ArchiveError(
      "message_too_large",
      `a message in the mbox is over ${Math.floor(maxMessage / (1024 * 1024))} MB, the most a mailbox accepts`,
    )
  const message = new ByteBuilder(maxMessage, tooLarge)
  // A line that straddles two chunks; the common case never touches it.
  const straddle = new ByteBuilder(maxMessage, tooLarge)

  const finish = (): Uint8Array | null => {
    const trimmed = trimSeparator(message.view())
    const out = trimmed.byteLength === 0 ? null : toCrlf(trimmed.slice())
    message.reset()
    return out
  }

  const addLine = (line: Uint8Array): Uint8Array | null => {
    const kind = classify(line)
    if (kind === "separator") return finish()
    message.append(kind === "quoted" ? line.subarray(1) : line)
    return null
  }

  for await (const chunk of chunks) {
    let at = 0
    while (at < chunk.byteLength) {
      const newline = chunk.indexOf(10, at)
      if (newline === -1) {
        straddle.append(chunk.subarray(at))
        break
      }
      let line = chunk.subarray(at, newline + 1)
      at = newline + 1
      if (straddle.length > 0) {
        straddle.append(line)
        line = straddle.view()
      }
      const done = addLine(line)
      straddle.reset()
      if (done) yield done
    }
  }

  // A last line with no newline.
  if (straddle.length > 0) {
    const done = addLine(straddle.view())
    if (done) yield done
  }
  const last = finish()
  if (last) yield last
}
