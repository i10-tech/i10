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
 * ⚠ THE WIRE FORMAT IS STANDARD WEBHOOKS, NOT OURS. It was a bespoke scheme —
 * a bare hex digest over `timestamp.body` in an `i10-signature` header — until
 * 2026-09-04, when it moved to the published spec while there were still no
 * customers holding the old one. See `docs/decisions/metering.md`.
 *
 *   webhook-id:        <delivery id, stable across retries, AND signed>
 *   webhook-timestamp: <unix seconds, AND signed>
 *   webhook-signature: <space-delimited list of "v1,<base64 hmac-sha256>">
 *
 * ⚠ THE SIGNED MATERIAL IS `id.timestamp.body`, AND THE ID BEING IN IT IS THE
 * POINT. Under the old scheme the delivery id travelled beside the signature
 * rather than inside it, so anyone replaying a captured delivery could rewrite
 * it — and a receiver deduplicating on that id would treat one replayed event
 * as many distinct ones.
 *
 * ⚠ THE LIST IS WHAT MAKES ROTATION POSSIBLE, and it is why the header is not
 * a single value. Signing with the new secret AND the old one for an overlap
 * window lets a customer change their secret without dropping a delivery; a
 * receiver takes any one match as a pass.
 *
 * ⚠ THE HMAC KEY IS THE DECODED BYTES, NOT THE PRINTABLE SECRET. `whsec_…` is
 * a base64 payload behind a prefix. Keying with the string as typed produces a
 * different digest that verifies fine against our own code and fails against
 * every off-the-shelf Standard Webhooks library — which is the whole reason we
 * moved. `webhooks/svix.ts` decodes the same way for the inbound direction.
 *
 * `test/webhook-signing.test.ts` and `packages/next/test/webhook.test.ts` pin
 * the same vector from both sides, which is what stops the two drifting again.
 */

/** Seconds a signature stays acceptable. Documented for receivers to enforce. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * ⚠ THE PREFIX IS PART OF WHAT MAKES A LEAK FINDABLE. `whsec_` in a paste, a
 * log line or a public repository is greppable by a secret scanner and obvious
 * to a human; 32 anonymous base64 characters are neither.
 *
 * Base64 rather than hex because the spec says the payload is base64 and every
 * conforming library decodes it that way. 24 bytes sits inside the spec's
 * 24–64 byte range.
 */
export const generateSecret = (): string =>
  `whsec_${randomBytes(24).toString("base64")}`

/** Unix seconds, as the `webhook-timestamp` header carries them. */
export const timestampFor = (at: Date): string =>
  String(Math.floor(at.getTime() / 1000))

/**
 * The value of the `webhook-signature` header.
 *
 * One signature today. The return type is the list form from the outset so that
 * adding a second during a rotation is a change here and nowhere else.
 */
export function signPayload(
  secret: string,
  id: string,
  body: string,
  at: Date,
): string {
  return `v1,${digest(secret, id, timestampFor(at), body)}`
}

/**
 * ⚠ THE SECRET IS DECODED BEFORE IT KEYS THE HMAC. See the note at the top of
 * the file: keying with the printable form is the one mistake that looks
 * correct from inside this repository and fails everywhere else.
 */
export function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  const decoded = Buffer.from(raw, "base64")
  if (decoded.length === 0) throw new Error("empty secret")
  return decoded
}

const digest = (secret: string, id: string, timestamp: string, body: string) =>
  createHmac("sha256", decodeSecret(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")

/**
 * Does any signature in a `webhook-signature` header match?
 *
 * ⚠ SHARED WITH THE INBOUND VERIFIER IN `webhooks/svix.ts` ON PURPOSE. The two
 * directions now speak one format, and two hand-written parsers for it is two
 * chances for one to drift into accepting something the other refuses.
 *
 * ⚠ CONSTANT TIME, AND NOT AS A MICRO-OPTIMISATION. `===` on a digest returns
 * as soon as two bytes differ, so the time it takes leaks how much of a guess
 * was right — enough to recover a valid signature one byte at a time against an
 * endpoint that answers quickly. An unparseable entry is skipped rather than
 * rejected outright, because a list may legitimately carry versions we do not
 * implement.
 */
export function matchesAnySignature(expected: Buffer, header: string): boolean {
  for (const part of header.split(" ")) {
    const [version, encoded] = part.split(",", 2)
    if (version !== "v1" || !encoded) continue

    let candidate: Buffer
    try {
      candidate = Buffer.from(encoded, "base64")
    } catch {
      continue
    }
    // timingSafeEqual throws on a length mismatch, so guard first. The length
    // is not a secret — the digest is a fixed 32 bytes.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true
    }
  }
  return false
}

/**
 * The mirror of `@i10/next`'s `verifySignature`, for our own tests.
 */
export function verifySignature(
  secret: string,
  id: string,
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

  let expected: Buffer
  try {
    expected = Buffer.from(digest(secret, id, timestamp, body), "base64")
  } catch {
    return false
  }
  return matchesAnySignature(expected, signature)
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
