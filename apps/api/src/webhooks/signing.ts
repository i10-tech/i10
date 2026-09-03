import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

/**
 * Signing what we send, and protecting the secret that signs it.
 *
 * ⚠ A WEBHOOK IS AN UNAUTHENTICATED POST INTO A CUSTOMER'S INFRASTRUCTURE. The
 * receiver has no way to know it came from us unless we prove it, and the
 * things a forged `email.bounced` can do to a customer are not small: mark a
 * user's address dead, unsubscribe them, fire an alert, roll back a signup. The
 * signature is the only thing between their endpoint and anyone who learns its
 * URL — and URLs leak, through logs, browser history, and screenshots.
 *
 * ⚠ THE TIMESTAMP IS PART OF THE SIGNED MATERIAL, NOT A HEADER BESIDE IT. Sign
 * only the body and a captured request stays valid forever: anyone who sees one
 * delivery can replay it a thousand times, and every replay verifies. Signing
 * `timestamp.body` means a replay is detectable, because the timestamp cannot
 * be changed without breaking the signature and a stale one can be refused.
 *
 * ⚠ THE WIRE FORMAT IS OWNED BY `@i10/next`, NOT BY THIS FILE. The published
 * SDK's `verifySignature` already reads a bare hex digest from `i10-signature`
 * and the seconds from `i10-timestamp`, and it is what customers have installed.
 * A prettier scheme here — Stripe's `t=…,v1=…`, say — would mean every webhook
 * we send is rejected by our own SDK, and the symptom is a 401 in the
 * customer's logs that looks like THEIR secret being wrong.
 *
 *   i10-signature: <hex hmac-sha256 of "timestamp.body">
 *   i10-timestamp: <unix seconds, and part of the signed material>
 *   i10-webhook-id: <delivery id, stable across retries>
 *
 * `test/webhook-signing.test.ts` and `packages/next/test/webhook.test.ts` pin
 * the same vector from both sides, which is what stops the two drifting again.
 */

/** Seconds a signature stays acceptable. Documented for receivers to enforce. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * ⚠ THE PREFIX IS PART OF WHAT MAKES A LEAK FINDABLE. `whsec_` in a paste, a
 * log line or a public repository is greppable by a secret scanner and obvious
 * to a human; 32 anonymous hex characters are neither.
 */
export const generateSecret = (): string => `whsec_${randomBytes(24).toString("hex")}`

/** Unix seconds, as the `i10-timestamp` header carries them. */
export const timestampFor = (at: Date): string =>
  String(Math.floor(at.getTime() / 1000))

/** The value of the `i10-signature` header: a bare hex digest, as the SDK reads. */
export function signPayload(secret: string, body: string, at: Date): string {
  return hmac(secret, `${timestampFor(at)}.${body}`)
}

const hmac = (secret: string, material: string) =>
  createHmac("sha256", secret).update(material).digest("hex")

/**
 * The mirror of `@i10/next`'s `verifySignature`, for our own tests.
 *
 * ⚠ CONSTANT TIME, AND NOT AS A MICRO-OPTIMISATION. `===` on a hex string
 * returns as soon as two characters differ, so the time it takes leaks how much
 * of a guess was right — which is enough to recover a valid signature one
 * character at a time against an endpoint that answers quickly.
 */
export function verifySignature(
  secret: string,
  body: string,
  signature: string,
  timestamp: string,
  now: Date = new Date(),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const t = Number(timestamp)
  if (!Number.isFinite(t)) return false

  // ⚠ BOTH DIRECTIONS. Refusing only old timestamps lets a forger with a
  // skewed clock — or a deliberately future one — mint a signature that stays
  // valid for as long as they chose.
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) return false

  return equalSecrets(hmac(secret, `${timestamp}.${body}`), signature)
}

/**
 * ⚠ CONSTANT-TIME COMPARISON, IN ONE PLACE. `timingSafeEqual` throws on a
 * length mismatch, so every caller needs the same length guard first — and
 * three copies of that guard is three chances for one of them to become `===`
 * during a refactor, which is a leak nothing would ever fail on.
 */
export function equalSecrets(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(given, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The secret at rest.
 *
 * ⚠ ENCRYPTED, NOT HASHED, BECAUSE A SIGNATURE IS COMPUTED RATHER THAN
 * COMPARED. The delivery worker needs the secret back to sign with it, so the
 * one-way storage a password gets is not available. What is available is
 * separating the two halves: the ciphertext lives in Postgres and the key lives
 * in the environment, so a stolen backup — the most likely way a database
 * leaves the building — carries nothing usable.
 *
 * ⚠ AES-256-GCM, SO THE CIPHERTEXT IS AUTHENTICATED. Without the tag, a row
 * edited by anyone with write access decrypts to a different secret and the
 * only symptom is every signature silently failing verification at the
 * customer's end.
 *
 * Format: `v1.<iv base64url>.<tag base64url>.<ciphertext base64url>` — versioned
 * so a future key rotation or algorithm change can be recognised rather than
 * guessed.
 */
const KEY_BYTES = 32
const IV_BYTES = 12

export interface SecretBox {
  seal: (plaintext: string) => string
  open: (sealed: string) => string
}

/**
 * ⚠ THE KEY IS 32 BYTES, HEX OR BASE64, AND NOT A PASSPHRASE. Deriving one from
 * a human-typed string would need a KDF and a salt to store beside it; refusing
 * anything but a real key keeps that decision from being made badly later.
 * Generate with `openssl rand -hex 32`.
 */
export function secretBox(key: string): SecretBox {
  const bytes = decodeKey(key)
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `WEBHOOK_SECRET_KEY must be ${KEY_BYTES} bytes (64 hex characters); got ${bytes.length}`,
    )
  }

  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv("aes-256-gcm", bytes, iv)
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ])
      return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".")
    },

    open(sealed) {
      const [version, iv, tag, ciphertext] = sealed.split(".")
      if (version !== "v1" || !iv || !tag || !ciphertext) {
        throw new Error("Unrecognised sealed secret")
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        bytes,
        Buffer.from(iv, "base64url"),
      )
      decipher.setAuthTag(Buffer.from(tag, "base64url"))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")
    },
  }
}

function decodeKey(key: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, "hex")
  return Buffer.from(key, "base64")
}
