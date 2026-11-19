import {
  gcmOpen,
  gcmSeal,
  newDataKey,
  unwrapKey,
  wrapKey,
  type KeyPurpose,
} from "../crypto/envelope.js"
import type { Keyring } from "../crypto/keyring.js"

/**
 * Sealing a message body for R2 (#184, #188): compress, then encrypt with a key
 * of its own, wrapped by a `CONTENT_KEYS` master key (crypto/envelope.ts).
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

/** `message_bodies.body_key`, under `CONTENT_KEYS`. */
export const BODY_KEY: KeyPurpose<BodyIds> = {
  what: "message body",
  aad: ({ tenantId, messageId }) => Buffer.from(`i10/body/v1/${tenantId}/${messageId}`),
}

export interface Sealed {
  record: Buffer
  /** Base64, for `message_bodies.body_key`. */
  wrappedKey: string
}

export function sealBody(keyring: Keyring, ids: BodyIds, body: Body): Sealed {
  const bodyKey = newDataKey()
  const plain = Buffer.from(JSON.stringify([body.html, body.text]))
  const record = gcmSeal(
    bodyKey,
    Bun.zstdCompressSync(plain, { level: 9 }),
    BODY_KEY.aad(ids),
  )
  const wrapped = wrapKey(BODY_KEY, keyring, ids, bodyKey)
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
  const bodyKey = unwrapKey(BODY_KEY, keyring, ids, wrappedKey)
  const plain = Bun.zstdDecompressSync(gcmOpen(bodyKey, record, BODY_KEY.aad(ids)))
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
