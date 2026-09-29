import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

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

/** Master keys by id. The first is the one new bodies are wrapped with. */
export interface Keyring {
  current: string
  keys: ReadonlyMap<string, Buffer>
}

const KID = /^[A-Za-z0-9_-]{1,32}$/

/**
 * `CONTENT_KEYS`: `kid:base64,kid:base64`, the current key first. Rotating is
 * putting a new key at the front and keeping the old ones until every body
 * wrapped with them has expired.
 */
export function parseKeyring(value: string): Keyring {
  const keys = new Map<string, Buffer>()
  let current: string | null = null
  for (const part of value.split(",")) {
    const entry = part.trim()
    if (!entry) continue
    const at = entry.indexOf(":")
    const kid = entry.slice(0, at)
    const key = Buffer.from(entry.slice(at + 1), "base64")
    if (at < 1 || !KID.test(kid)) {
      throw new Error("CONTENT_KEYS: each entry is kid:base64, kid of [A-Za-z0-9_-]")
    }
    if (key.byteLength !== 32) {
      throw new Error(`CONTENT_KEYS: key ${kid} is not 32 bytes of base64`)
    }
    if (keys.has(kid)) throw new Error(`CONTENT_KEYS: key ${kid} appears twice`)
    keys.set(kid, key)
    current ??= kid
  }
  if (!current) throw new Error("CONTENT_KEYS: no key")
  return { current, keys }
}

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

export function sealBody(keyring: Keyring, ids: BodyIds, body: Body): Sealed {
  const bodyKey = randomBytes(32)
  const plain = Buffer.from(JSON.stringify([body.html, body.text]))
  const record = encrypt(bodyKey, Bun.zstdCompressSync(plain, { level: 9 }), aad(ids))
  const kid = Buffer.from(keyring.current)
  const wrapped = Buffer.concat([
    Buffer.from([kid.byteLength]),
    kid,
    encrypt(keyring.keys.get(keyring.current)!, bodyKey, aad(ids)),
  ]).toString("base64")
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
  const wrapped = Buffer.from(wrappedKey, "base64")
  const kidLength = wrapped[0] ?? 0
  const kid = wrapped.subarray(1, 1 + kidLength).toString()
  const master = keyring.keys.get(kid)
  if (!master) {
    // ⚠ LOUD. A body wrapped with a key we no longer hold is lost mail, and a
    // rotation that dropped an old key too early is how it would happen.
    throw new Error(`message body is wrapped with key ${kid}, which is not configured`)
  }
  const bodyKey = decrypt(master, wrapped.subarray(1 + kidLength), aad(ids))
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
