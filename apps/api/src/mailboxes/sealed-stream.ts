import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import type { KeyPurpose } from "../crypto/envelope.js"

/**
 * A mailbox export archive, sealed as it streams to R2 and opened as it streams
 * out (#385): the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár) over
 * AES-256-GCM, with the archive's own random key.
 *
 *   header   "i10x" | version(1) = 1 | nonce prefix(7)
 *   chunk    AES-256-GCM(64 KiB of the archive) | tag(16), the last one shorter
 *   nonce    prefix(7) | chunk number, uint32 big-endian | 1 on the last chunk, else 0
 *   AAD      i10/export/v1/<tenant>/<job>, on every chunk
 *
 * ⚠ THE NONCE SAYS WHERE A CHUNK IS AND WHETHER IT IS THE LAST. A chunk moved,
 * dropped or repeated opens under the wrong number and fails; an archive cut
 * at any point lacks a chunk sealed as the last one and fails at its end, so a
 * short download is an error, never a shorter archive.
 *
 * ⚠ ONE CHUNK IN MEMORY EACH WAY. A chunk is sealed only once a byte past it
 * has arrived, which is how the last one is known without reading ahead more.
 * An empty archive is one empty last chunk.
 */

export interface ExportIds {
  tenantId: string
  jobId: string
}

/** The archive and its key are bound to the same label. */
export const EXPORT_KEY: KeyPurpose<ExportIds> = {
  what: "mailbox export",
  aad: ({ tenantId, jobId }) => Buffer.from(`i10/export/v1/${tenantId}/${jobId}`),
}

export const CHUNK_BYTES = 64 * 1024
const TAG = 16
const SEALED_CHUNK = CHUNK_BYTES + TAG
const MAGIC = Buffer.from("i10x")
const VERSION = 1
const PREFIX = 7
const HEADER = MAGIC.byteLength + 1 + PREFIX
const MAX_CHUNKS = 2 ** 32

const nonce = (prefix: Buffer, index: number, last: boolean) => {
  if (index >= MAX_CHUNKS) throw new Error("mailbox export is too long to seal")
  const n = Buffer.alloc(12)
  prefix.copy(n, 0)
  n.writeUInt32BE(index, PREFIX)
  n[11] = last ? 1 : 0
  return n
}

/** What `seal` writes for `plainBytes` of archive. */
export function sealedLength(plainBytes: number): number {
  const chunks = Math.max(1, Math.ceil(plainBytes / CHUNK_BYTES))
  return HEADER + plainBytes + chunks * TAG
}

/** The archive length a sealed object holds, or null if no archive has that size. */
export function plainLength(sealedBytes: number): number | null {
  const body = sealedBytes - HEADER
  if (body < TAG) return null
  const full = Math.floor(body / SEALED_CHUNK)
  const rest = body % SEALED_CHUNK
  if (rest === 0) return full * CHUNK_BYTES
  if (rest < TAG) return null
  return full * CHUNK_BYTES + rest - TAG
}

/** Fills one chunk at a time from pieces of any size. */
function chunker(size: number, emit: (chunk: Buffer) => void) {
  let buffer = Buffer.alloc(size)
  let filled = 0
  return {
    push(piece: Uint8Array) {
      for (let at = 0; at < piece.byteLength;) {
        // ⚠ FULL AND MORE IS COMING: only now is it known not to be the last.
        if (filled === size) {
          emit(buffer)
          buffer = Buffer.alloc(size)
          filled = 0
        }
        const n = Math.min(size - filled, piece.byteLength - at)
        buffer.set(piece.subarray(at, at + n), filled)
        filled += n
        at += n
      }
    },
    rest: () => buffer.subarray(0, filled),
  }
}

/** Plain archive in, sealed object out. */
export function sealStream(
  key: Buffer,
  ids: ExportIds,
): TransformStream<Uint8Array, Uint8Array> {
  const aad = EXPORT_KEY.aad(ids)
  const prefix = randomBytes(PREFIX)
  let index = 0
  const seal = (plain: Buffer, last: boolean) => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, index++, last))
    cipher.setAAD(aad)
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  }
  let chunks: ReturnType<typeof chunker>
  return new TransformStream({
    start(controller) {
      chunks = chunker(CHUNK_BYTES, (c) => controller.enqueue(seal(c, false)))
      controller.enqueue(Buffer.concat([MAGIC, Buffer.from([VERSION]), prefix]))
    },
    transform(piece) {
      chunks.push(piece)
    },
    flush(controller) {
      controller.enqueue(seal(chunks.rest(), true))
    },
  })
}

/**
 * Sealed object in, plain archive out. Errors the stream on anything that does
 * not open, with a message that holds no key and no content.
 */
export function openStream(
  key: Buffer,
  ids: ExportIds,
): TransformStream<Uint8Array, Uint8Array> {
  const aad = EXPORT_KEY.aad(ids)
  let header = Buffer.alloc(0)
  let prefix: Buffer | null = null
  let index = 0
  const open = (sealed: Buffer, last: boolean) => {
    if (sealed.byteLength < TAG) throw new Error("mailbox export is truncated")
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix!, index++, last))
    decipher.setAAD(aad)
    decipher.setAuthTag(sealed.subarray(sealed.byteLength - TAG))
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.byteLength - TAG)),
        decipher.final(),
      ])
    } catch {
      throw new Error(
        `mailbox export does not open at chunk ${index - 1}: tampered, truncated or not this export`,
      )
    }
  }
  let chunks: ReturnType<typeof chunker>
  return new TransformStream({
    start(controller) {
      chunks = chunker(SEALED_CHUNK, (c) => controller.enqueue(open(c, false)))
    },
    transform(piece) {
      if (!prefix) {
        header = Buffer.concat([header, piece])
        if (header.byteLength < HEADER) return
        if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC))
          throw new Error("mailbox export is not a sealed archive")
        if (header[MAGIC.byteLength] !== VERSION)
          throw new Error(
            `mailbox export has unknown version ${header[MAGIC.byteLength]}`,
          )
        prefix = Buffer.from(header.subarray(MAGIC.byteLength + 1, HEADER))
        piece = header.subarray(HEADER)
      }
      chunks.push(piece)
    },
    flush(controller) {
      if (!prefix) throw new Error("mailbox export is truncated")
      controller.enqueue(open(Buffer.from(chunks.rest()), true))
    },
  })
}
