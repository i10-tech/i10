import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { keyringFromEnv, type Keyring } from "./keyring.js"

/**
 * HMAC keys for the tokens we sign and later check (`TOKEN_KEYS`).
 *
 * ⚠ ONE SUBKEY PER USE, DERIVED WITH HKDF. A MAC made for one use never
 * verifies as another, so a download link cannot be passed off as an OAuth
 * state, and the PKCE verifier cannot be computed from anything a browser sees.
 *
 * ⚠ SIGNED WITH THE CURRENT KEY, ACCEPTED UNDER ANY KEY IN THE RING. Putting a
 * new key first does not break a token already handed out; dropping the old
 * key does, so keep it for as long as the longest token lives (15 minutes).
 */
export type TokenUse = "mailbox-download" | "dns-oauth-state" | "dns-oauth-pkce"

const USES: readonly TokenUse[] = [
  "mailbox-download",
  "dns-oauth-state",
  "dns-oauth-pkce",
]

export interface TokenKeys {
  /** The base64url HMAC of `data` for `use`, under `kid` (default: the current key). */
  sign(use: TokenUse, data: string, kid?: string): string
  /** The kid whose subkey made `mac`, or null. Every key is tried in constant time. */
  verify(use: TokenUse, data: string, mac: string): string | null
}

export function tokenKeys(ring: Keyring): TokenKeys {
  const subkeys = new Map<string, Record<TokenUse, Buffer>>()
  for (const [kid, master] of ring.keys) {
    subkeys.set(
      kid,
      Object.fromEntries(
        USES.map((use) => [
          use,
          Buffer.from(
            hkdfSync("sha256", master, Buffer.alloc(0), `i10/token/v1/${use}`, 32),
          ),
        ]),
      ) as Record<TokenUse, Buffer>,
    )
  }

  const mac = (use: TokenUse, data: string, kid: string) => {
    const key = subkeys.get(kid)?.[use]
    if (!key) throw new Error(`TOKEN_KEYS has no key ${kid}`)
    return createHmac("sha256", key).update(data).digest()
  }

  return {
    sign: (use, data, kid = ring.current) => mac(use, data, kid).toString("base64url"),

    verify(use, data, given) {
      const candidate = Buffer.from(given, "base64url")
      // Base64 decoding skips stray characters; one spelling per MAC only.
      if (candidate.toString("base64url") !== given) return null
      for (const kid of subkeys.keys()) {
        const expected = mac(use, data, kid)
        if (
          candidate.length === expected.length &&
          timingSafeEqual(candidate, expected)
        ) {
          return kid
        }
      }
      return null
    },
  }
}

/** Null: every feature that signs a token is off. */
export const tokenKeysFromEnv = (value: string | undefined): TokenKeys | null =>
  value ? tokenKeys(keyringFromEnv("TOKEN_KEYS", value)) : null
