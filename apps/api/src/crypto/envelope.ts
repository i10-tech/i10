import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { currentKey, KID, type Keyring } from "./keyring.js"

/**
 * Envelope encryption, as message bodies, stored files and mailbox exports use
 * it: the content is sealed with a random data key of its own, and only that
 * key is sealed with a master key from a keyring.
 *
 *   sealed      nonce(12) | AES-256-GCM(plain) | tag(16)
 *   wrapped key kid-length(1) | kid | nonce(12) | AES-256-GCM(data key) | tag(16)
 *
 * ⚠ A ROTATION REWRITES ONLY THE WRAPPED KEYS. The content in R2 is sealed with
 * the data key, which never changes, so retiring a master key is a pass over
 * Postgres (scripts/rewrap-keys.ts).
 *
 * ⚠ EVERY WRAPPED KEY IS BOUND TO ITS OWNER as associated data, which its
 * `KeyPurpose` builds from the row's ids. A key copied onto another row fails
 * to open instead of opening the wrong content.
 */

/** What a data key protects, and the ids it is bound to. */
export interface KeyPurpose<Ids> {
  /** Names the thing in errors: "message body". Errors carry nothing else. */
  what: string
  aad(ids: Ids): Buffer
}

export const DATA_KEY_BYTES = 32
/** nonce(12) | AES-256-GCM(data key) | tag(16) */
const WRAPPED_BYTES = 12 + DATA_KEY_BYTES + 16

export const newDataKey = () => randomBytes(DATA_KEY_BYTES)

export function gcmSeal(key: Buffer, plain: Uint8Array, aad: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export function gcmOpen(key: Buffer, sealed: Uint8Array, aad: Buffer): Buffer {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  if (bytes.byteLength < 28) throw new Error("sealed content is truncated")
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
  decipher.setAAD(aad)
  decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16))
  return Buffer.concat([
    decipher.update(bytes.subarray(12, bytes.byteLength - 16)),
    decipher.final(),
  ])
}

/** The data key wrapped under the ring's current key, as base64. */
export function wrapKey<Ids>(
  purpose: KeyPurpose<Ids>,
  ring: Keyring,
  ids: Ids,
  dataKey: Buffer,
): string {
  const kid = Buffer.from(ring.current)
  return Buffer.concat([
    Buffer.from([kid.byteLength]),
    kid,
    gcmSeal(currentKey(ring), dataKey, purpose.aad(ids)),
  ]).toString("base64")
}

function parseWrapped(wrapped: string): { kid: string; sealed: Buffer } | null {
  const bytes = Buffer.from(wrapped, "base64")
  const kidLength = bytes[0] ?? 0
  const kid = bytes.subarray(1, 1 + kidLength).toString()
  if (!KID.test(kid) || bytes.byteLength !== 1 + kidLength + WRAPPED_BYTES) return null
  return { kid, sealed: bytes.subarray(1 + kidLength) }
}

/** The kid a wrapped key is under, without opening it; null if it is not one. */
export const keyUnder = (wrapped: string): string | null =>
  parseWrapped(wrapped)?.kid ?? null

/**
 * ⚠ ERRORS NAME THE KID AND NOTHING ELSE. The rewrap job prints them next to
 * row ids; the key, the value and the cipher's own message stay out.
 */
export function unwrapKey<Ids>(
  purpose: KeyPurpose<Ids>,
  ring: Keyring,
  ids: Ids,
  wrapped: string,
): Buffer {
  const parsed = parseWrapped(wrapped)
  if (!parsed) throw new Error(`${purpose.what} key is not well formed`)
  const master = ring.keys.get(parsed.kid)
  if (!master) {
    // ⚠ LOUD. Content wrapped with a key we no longer hold is lost, and a
    // rotation that dropped an old key too early is how it would happen.
    throw new Error(
      `${purpose.what} is wrapped with key ${parsed.kid}, which is not configured`,
    )
  }
  try {
    return gcmOpen(master, parsed.sealed, purpose.aad(ids))
  } catch {
    throw new Error(`${purpose.what} key does not open under key ${parsed.kid}`)
  }
}

/**
 * The same data key, wrapped under the current master key: the step that lets
 * a rotation retire an old key.
 *
 * A key already under the current kid comes back as it was, once it opens:
 * rewriting it would only change the nonce.
 */
export function rewrapKey<Ids>(
  purpose: KeyPurpose<Ids>,
  ring: Keyring,
  ids: Ids,
  wrapped: string,
): string {
  const dataKey = unwrapKey(purpose, ring, ids, wrapped)
  if (keyUnder(wrapped) === ring.current) return wrapped
  const fresh = wrapKey(purpose, ring, ids, dataKey)
  // ⚠ CHECKED BEFORE IT IS WRITTEN: a wrong value here is deleted content.
  if (!unwrapKey(purpose, ring, ids, fresh).equals(dataKey)) {
    throw new Error(`a re-wrapped ${purpose.what} key does not open to the original`)
  }
  return fresh
}
