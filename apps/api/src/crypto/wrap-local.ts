import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { currentKey, keyringFromEnv, type Keyring } from "./keyring.js"
import type { WrapProvider } from "./unlock.js"

/**
 * The `local` wrap provider: AES-256-GCM under a key from `KEY_WRAP_KEYS`.
 * Its part of a wrapped value is `<kid>.<iv>.<tag>.<ciphertext>`, base64url.
 *
 * ⚠ `KEY_WRAP_KEYS` COMES FROM THE `i10-key-wrap` SECRET, WHICH DOPPLER NEVER
 * SEES. That split is the whole point: a leaked Doppler config holds only
 * wrapped values, and this key is what opens them.
 */

const KID = /^[A-Za-z0-9_-]{1,32}$/
const PART = /^[A-Za-z0-9_-]+$/
const IV_BYTES = 12
const TAG_BYTES = 16

function wrapRing(source: NodeJS.ProcessEnv): Keyring {
  const value = source.KEY_WRAP_KEYS
  if (!value) throw new Error("KEY_WRAP_KEYS is not set")
  return keyringFromEnv("KEY_WRAP_KEYS", value)
}

export const local: WrapProvider = {
  async wrap(plain, context, source) {
    const ring = wrapRing(source)
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", currentKey(ring), iv, {
      authTagLength: TAG_BYTES,
    })
    cipher.setAAD(Buffer.from(context))
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    return [ring.current, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".")
  },

  async unwrap(payload, context, source) {
    const parts = payload.split(".")
    const [kid = "", ...rest] = parts
    const [iv, tag, ciphertext] = rest.map((p) =>
      PART.test(p) ? Buffer.from(p, "base64url") : null,
    )
    if (
      parts.length !== 4 ||
      !KID.test(kid) ||
      iv?.byteLength !== IV_BYTES ||
      tag?.byteLength !== TAG_BYTES ||
      !ciphertext
    ) {
      throw new Error("is not a local wrapped value (<kid>.<iv>.<tag>.<ciphertext>)")
    }
    const key = wrapRing(source).keys.get(kid)
    if (!key)
      throw new Error(`is wrapped under key ${kid}, which is not in KEY_WRAP_KEYS`)
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_BYTES,
      })
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      )
    } catch {
      // The cause names nothing secret, but it is opaque; this says what to check.
      throw new Error(
        `does not unwrap with KEY_WRAP_KEYS key ${kid}: it was changed, or it was wrapped for another variable`,
      )
    }
  },
}
