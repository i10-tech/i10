import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { currentKey, KID, type Keyring } from "../crypto/keyring.js"

/**
 * Sealing a message body for R2 (#184, #188): compress, then encrypt with a key
 * of its own, wrapped by our master key.
 *
 *   record      nonce(12) | AES-256-GCM(zstd(JSON [html, text])) | tag(16)
 *   wrapped key kid-length(1) | kid | nonce(12) | AES-256-GCM(body key) | tag(16)
 *
 * ⚠ ONE KEY PER BODY, AND THAT IS HOW ONE EMAIL IS DELETED FROM A PACK. A pack
 * holds many bodies and cannot lose one from the middle without being
 * rewritten. Deleting the row's wrapped key makes that body's bytes unreadable
 * at once (crypto-shredding); the pack itself goes when no row names it.
 *
 * ⚠ THE WORKSPACE AND THE MESSAGE ARE BOUND IN AS ASSOCIATED DATA, on both the
 * record and the wrapped key. A record or a key copied onto another message's
 * row fails to open instead of showing one email as another.
 *
 * ⚠ COMPRESSED BEFORE ENCRYPTED. Ciphertext does not compress; the other order
 * would store every body at full size.
 *
 * ⚠ BYTE-EXACT. JSON round-trips any string Postgres can hold, and zstd and
 * GCM are exact; `sealBody` opens what it sealed before returning it anyway,
 * and the pack job checks again from what R2 returns.
 */

export interface BodyIds {
  tenantId: string
  messageId: string
}

export interface Body {
  html: string | null
  text: string | null
}

const aad = ({ tenantId, messageId }: BodyIds) =>
  Buffer.from(`i10/body/v1/${tenantId}/${messageId}`)

function encrypt(key: Buffer, plain: Uint8Array, data: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(data)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

function decrypt(key: Buffer, sealed: Uint8Array, data: Buffer): Buffer {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  if (bytes.byteLength < 28) throw new Error("sealed content is truncated")
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
  decipher.setAAD(data)
  decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16))
  return Buffer.concat([
    decipher.update(bytes.subarray(12, bytes.byteLength - 16)),
    decipher.final(),
  ])
}

export interface Sealed {
  record: Buffer
  /** Base64, for `message_bodies.body_key`. */
  wrappedKey: string
}

const BODY_KEY_BYTES = 32
/** nonce(12) | AES-256-GCM(body key) | tag(16) */
const WRAPPED_BYTES = 12 + BODY_KEY_BYTES + 16

function wrapBodyKey(keyring: Keyring, ids: BodyIds, bodyKey: Buffer): string {
  const kid = Buffer.from(keyring.current)
  return Buffer.concat([
    Buffer.from([kid.byteLength]),
    kid,
    encrypt(currentKey(keyring), bodyKey, aad(ids)),
  ]).toString("base64")
}

function parseWrapped(wrappedKey: string): { kid: string; sealed: Buffer } | null {
  const wrapped = Buffer.from(wrappedKey, "base64")
  const kidLength = wrapped[0] ?? 0
  const kid = wrapped.subarray(1, 1 + kidLength).toString()
  if (!KID.test(kid) || wrapped.byteLength !== 1 + kidLength + WRAPPED_BYTES)
    return null
  return { kid, sealed: wrapped.subarray(1 + kidLength) }
}

/** The kid a wrapped body key is under, without opening it; null if it is not one. */
export const bodyKeyUnder = (wrappedKey: string): string | null =>
  parseWrapped(wrappedKey)?.kid ?? null

/**
 * ⚠ ERRORS NAME THE KID AND NOTHING ELSE. The rewrap job prints them next to
 * row ids; the key, the value and the cipher's own message stay out.
 */
function unwrapBodyKey(keyring: Keyring, ids: BodyIds, wrappedKey: string): Buffer {
  const parsed = parseWrapped(wrappedKey)
  if (!parsed) throw new Error("message body key is not well formed")
  const master = keyring.keys.get(parsed.kid)
  if (!master) {
    // ⚠ LOUD. A body wrapped with a key we no longer hold is lost mail, and a
    // rotation that dropped an old key too early is how it would happen.
    throw new Error(
      `message body is wrapped with key ${parsed.kid}, which is not configured`,
    )
  }
  try {
    return decrypt(master, parsed.sealed, aad(ids))
  } catch {
    throw new Error(`message body key does not open under key ${parsed.kid}`)
  }
}

/**
 * The same body key, wrapped under the current master key: the step that lets
 * a rotation retire an old key without waiting for retention. The record in R2
 * is sealed with the body key itself, so it does not change.
 *
 * A key already under the current kid comes back as it was, once it opens:
 * rewriting it would only change the nonce.
 */
export function rewrapBodyKey(
  keyring: Keyring,
  ids: BodyIds,
  wrappedKey: string,
): string {
  const bodyKey = unwrapBodyKey(keyring, ids, wrappedKey)
  if (bodyKeyUnder(wrappedKey) === keyring.current) return wrappedKey
  const fresh = wrapBodyKey(keyring, ids, bodyKey)
  // ⚠ CHECKED BEFORE IT IS WRITTEN: a wrong value here is a deleted email.
  if (!unwrapBodyKey(keyring, ids, fresh).equals(bodyKey)) {
    throw new Error("a re-wrapped body key does not open to the original")
  }
  return fresh
}

export function sealBody(keyring: Keyring, ids: BodyIds, body: Body): Sealed {
  const bodyKey = randomBytes(BODY_KEY_BYTES)
  const plain = Buffer.from(JSON.stringify([body.html, body.text]))
  const record = encrypt(bodyKey, Bun.zstdCompressSync(plain, { level: 9 }), aad(ids))
  const wrapped = wrapBodyKey(keyring, ids, bodyKey)
  // ⚠ CHECKED HERE, before anything is uploaded or released.
  const back = openBody(keyring, ids, record, wrapped)
  if (back.html !== body.html || back.text !== body.text) {
    throw new Error("a sealed body does not open to the original")
  }
  return { record, wrappedKey: wrapped }
}

export function openBody(
  keyring: Keyring,
  ids: BodyIds,
  record: Uint8Array,
  wrappedKey: string,
): Body {
  const bodyKey = unwrapBodyKey(keyring, ids, wrappedKey)
  const plain = Bun.zstdDecompressSync(decrypt(bodyKey, record, aad(ids)))
  const parsed = JSON.parse(Buffer.from(plain).toString()) as unknown
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !parsed.every((v) => v === null || typeof v === "string")
  ) {
    throw new Error("a sealed body is not a body")
  }
  return { html: parsed[0] as string | null, text: parsed[1] as string | null }
}
