import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"
import { generateSecret, signPayload, timestampFor } from "./signing.js"

/**
 * The keys an endpoint signs with, and the rules for replacing them.
 *
 * ⚠ TWO SCHEMES, BOTH STANDARD WEBHOOKS. `hmac_sha256` is the shared secret
 * every receiver already understands (`v1,`). `ed25519` is the asymmetric one
 * (`v1a,`): we keep the private key and the customer verifies with a public
 * key, so nothing they store can be used to forge a webhook from us. Same
 * signed material for both: `id.timestamp.body`.
 *
 * ⚠ AN OLD SECRET STAYS LIVE ONLY IF THE CUSTOMER SAID SO, AND NEVER FOR LONG.
 * A stolen secret that keeps verifying after a rotation is a risk we will not
 * take on silently for anyone, so rotation has no default for the secret it
 * replaces (docs/decisions/webhooks.md, decision 7). The customer chooses:
 * revoke it now, or keep it for a period they pick, capped at 72 hours.
 */

export type SignatureScheme = "hmac_sha256" | "ed25519"

export const SIGNATURE_SCHEMES = ["hmac_sha256", "ed25519"] as const

/** A key as the signer needs it. `secret` is `whsec_...` or `whsk_...`. */
export interface SigningKey {
  scheme: SignatureScheme
  secret: string
}

/** A freshly minted key, with what the customer is shown. */
export interface IssuedKey extends SigningKey {
  /** `whpk_...` for ed25519, which the customer verifies with; null for HMAC. */
  publicKey: string | null
}

/**
 * The shortest and longest an old secret may keep signing after a rotation.
 *
 * ⚠ 72 HOURS IS THE CEILING ON PURPOSE. It covers a rotation started on a
 * Friday and deployed on a Monday. Past that, an old secret is a liability
 * rather than a convenience, and a customer who needs longer has not deployed
 * at all - which revoking and rotating again handles better.
 */
export const MIN_GRACE_SECONDS = 60
export const MAX_GRACE_SECONDS = 72 * 60 * 60

/** The current key plus at most two retiring ones. */
export const MAX_LIVE_KEYS = 3

// The fixed PKCS#8 prefix for an Ed25519 private key, so a stored 32-byte seed
// can be turned back into a key object without also storing the public half.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

export function generateKey(scheme: SignatureScheme): IssuedKey {
  if (scheme === "hmac_sha256") {
    return { scheme, secret: generateSecret(), publicKey: null }
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url")
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")
  return {
    scheme,
    secret: `whsk_${seed.toString("base64")}`,
    publicKey: `whpk_${pub.toString("base64")}`,
  }
}

function ed25519PrivateKey(secret: string) {
  const seed = Buffer.from(secret.replace(/^whsk_/, ""), "base64")
  if (seed.length !== 32) throw new Error("an ed25519 secret is a 32-byte seed")
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  })
}

/** The `whpk_` public key for a stored ed25519 secret. */
export function publicKeyFor(secret: string): string {
  const jwk = createPublicKey(ed25519PrivateKey(secret)).export({ format: "jwk" })
  return `whpk_${Buffer.from(jwk.x!, "base64url").toString("base64")}`
}

/**
 * The `webhook-signature` header: one entry per live key, space-separated.
 *
 * ⚠ EVERY LIVE KEY SIGNS, CURRENT FIRST. A receiver that has deployed the new
 * secret and one that has not both find a match, which is the whole of what
 * a grace period is for.
 */
export function signWithKeys(
  keys: readonly SigningKey[],
  id: string,
  body: string,
  at: Date,
): string {
  if (keys.length === 0) throw new Error("no signing key")
  return keys
    .map((key) => {
      if (key.scheme === "hmac_sha256") return signPayload(key.secret, id, body, at)
      const signed = Buffer.from(`${id}.${timestampFor(at)}.${body}`)
      return `v1a,${sign(null, signed, ed25519PrivateKey(key.secret)).toString("base64")}`
    })
    .join(" ")
}

/** Verifies any `v1a,` entry in a header against a `whpk_` public key. */
export function verifyEd25519(
  publicKey: string,
  id: string,
  timestamp: string,
  body: string,
  header: string,
): boolean {
  const raw = Buffer.from(publicKey.replace(/^whpk_/, ""), "base64")
  if (raw.length !== 32) return false
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  })
  const signed = Buffer.from(`${id}.${timestamp}.${body}`)
  return header.split(" ").some((part) => {
    const [version, encoded] = part.split(",", 2)
    if (version !== "v1a" || !encoded) return false
    const sig = Buffer.from(encoded, "base64")
    return sig.length === 64 && verify(null, signed, key, sig)
  })
}

/** A key that has been replaced and is still signing until `expiresAt`. */
export interface RetiringSecret {
  /** Sealed with the webhook secret box, like the current one. */
  ciphertext: string
  scheme: SignatureScheme
  expiresAt: string
}

/** What the customer chose for the secret a rotation replaces. */
export type PreviousSecretChoice =
  { action: "revoke" } | { action: "expire"; expiresInSeconds: number }

/** The retiring keys that still sign at `now`. */
export const liveRetiring = (retiring: readonly RetiringSecret[], now: Date) =>
  retiring.filter((r) => Date.parse(r.expiresAt) > now.getTime())

/**
 * The retiring list after a rotation, or why the rotation is refused.
 *
 * ⚠ EXPIRED ENTRIES ARE DROPPED HERE, NOT KEPT AND IGNORED, so key material a
 * customer let lapse does not sit in the row until some later cleanup.
 */
export function planRotation(
  current: { ciphertext: string; scheme: SignatureScheme },
  retiring: readonly RetiringSecret[],
  choice: PreviousSecretChoice,
  now: Date,
): { ok: true; retiring: RetiringSecret[] } | { ok: false; reason: string } {
  const live = liveRetiring(retiring, now)

  if (choice.action === "revoke") return { ok: true, retiring: live }

  const s = choice.expiresInSeconds
  if (!Number.isInteger(s) || s < MIN_GRACE_SECONDS || s > MAX_GRACE_SECONDS) {
    return {
      ok: false,
      reason: `\`expires_in\` must be a whole number of seconds from ${MIN_GRACE_SECONDS} to ${MAX_GRACE_SECONDS} (72 hours).`,
    }
  }

  // The new key is one more live key on top of these.
  if (live.length + 2 > MAX_LIVE_KEYS) {
    const soonest = live.map((r) => r.expiresAt).sort()[0]!
    return {
      ok: false,
      reason:
        `At most ${MAX_LIVE_KEYS} signing secrets can be live at once. Revoke the previous ` +
        `secrets, rotate with \`previous_secret: "revoke"\`, or wait until ${soonest}.`,
    }
  }

  return {
    ok: true,
    retiring: [
      ...live,
      {
        ciphertext: current.ciphertext,
        scheme: current.scheme,
        expiresAt: new Date(now.getTime() + s * 1000).toISOString(),
      },
    ],
  }
}
