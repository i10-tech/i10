import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Verification for Clerk's webhooks, which are delivered through Svix.
 *
 * ⚠ THIS IS AN AUTHENTICATION BOUNDARY, NOT A CHECKSUM. Everything downstream
 * of it writes to the mailbox projection: which addresses exist, and — once
 * billing drives it — which mailboxes accept mail. A forged event could create
 * a mailbox on a domain we host or silence somebody else's. Nothing may reach
 * the projection without passing here.
 *
 * Implemented directly rather than pulling in the `svix` package. The algorithm
 * is fixed and published (Standard Webhooks), it is forty lines, and it sits in
 * the authentication path where a transitive dependency is a liability rather
 * than a convenience. The tests below cover the failure modes that matter —
 * wrong key, tampered body, replayed timestamp, malformed header.
 */

/** Svix rejects timestamps outside this window, and so do we. */
const TOLERANCE_SECONDS = 5 * 60

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export interface SvixHeaders {
  id: string | undefined
  timestamp: string | undefined
  signature: string | undefined
}

/**
 * Reads the Svix headers, accepting both the `svix-` names Clerk sends and the
 * vendor-neutral `webhook-` names the Standard Webhooks spec defines.
 */
export function readSvixHeaders(
  get: (name: string) => string | undefined,
): SvixHeaders {
  return {
    id: get("svix-id") ?? get("webhook-id"),
    timestamp: get("svix-timestamp") ?? get("webhook-timestamp"),
    signature: get("svix-signature") ?? get("webhook-signature"),
  }
}

/**
 * Verifies a webhook signature.
 *
 * `body` must be the EXACT bytes received. Parsing to JSON and re-serialising
 * changes key order and whitespace, and the signature covers the raw text — so
 * the route reads the body as text, verifies, and only then parses.
 */
export function verifySvixSignature(
  body: string,
  headers: SvixHeaders,
  secret: string,
  now: Date = new Date(),
): VerifyResult {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing signature headers" }
  }

  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: "malformed timestamp" }
  }
  // Replay protection. Without it a captured request stays valid forever, and
  // a `user.deleted` capture becomes a permanent off switch for that mailbox.
  const drift = Math.abs(Math.floor(now.getTime() / 1000) - sentAt)
  if (drift > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" }
  }

  let key: Buffer
  try {
    key = decodeSecret(secret)
  } catch {
    return { ok: false, reason: "malformed signing secret" }
  }

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest()

  // The header carries a space-separated list so a secret can be rotated with
  // both keys live. Any one match is a pass.
  for (const part of signature.split(" ")) {
    const [version, encoded] = part.split(",", 2)
    if (version !== "v1" || !encoded) continue

    let candidate: Buffer
    try {
      candidate = Buffer.from(encoded, "base64")
    } catch {
      continue
    }
    // timingSafeEqual throws on a length mismatch, so guard first. Length is
    // not a secret — the digest is a fixed 32 bytes.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true }
    }
  }

  return { ok: false, reason: "no matching signature" }
}

/**
 * Svix secrets are `whsec_` followed by base64. The bytes are what key the
 * HMAC — using the printable form as the key silently produces a different
 * digest and every delivery fails verification.
 */
function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  const decoded = Buffer.from(raw, "base64")
  if (decoded.length === 0) throw new Error("empty secret")
  return decoded
}
