/**
 * Master keys by id, as `CONTENT_KEYS`, `SEAL_KEYS` and `TOKEN_KEYS` hold them:
 * `kid:base64,kid:base64`, the current key first. Rotating is putting a new key
 * at the front and keeping the old ones until nothing still needs them.
 */
export interface Keyring {
  current: string
  keys: ReadonlyMap<string, Buffer>
}

export const KID = /^[A-Za-z0-9_-]{1,32}$/

/**
 * ⚠ THE ONE PLACE AN ENVIRONMENT VALUE BECOMES KEY MATERIAL. A wrapped value
 * never gets here: `unlockEnv` (unlock.ts) opens it first, at process start.
 */
export function keyringFromEnv(name: string, value: string): Keyring {
  const keys = new Map<string, Buffer>()
  let current: string | null = null
  for (const part of value.split(",")) {
    const entry = part.trim()
    if (!entry) continue
    const at = entry.indexOf(":")
    const kid = entry.slice(0, at)
    const key = Buffer.from(entry.slice(at + 1), "base64")
    if (at < 1 || !KID.test(kid)) {
      throw new Error(`${name}: each entry is kid:base64, kid of [A-Za-z0-9_-]`)
    }
    if (key.byteLength !== 32) {
      throw new Error(`${name}: key ${kid} is not 32 bytes of base64`)
    }
    if (keys.has(kid)) throw new Error(`${name}: key ${kid} appears twice`)
    keys.set(kid, key)
    current ??= kid
  }
  if (!current) throw new Error(`${name}: no key`)
  return { current, keys }
}

/** The current key's bytes. Total: `keyringFromEnv` never yields a ring without it. */
export const currentKey = (ring: Keyring): Buffer => ring.keys.get(ring.current)!
