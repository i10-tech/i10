import { createHmac } from "node:crypto"
import { decodeSecret, matchesAnySignature } from "./signing.js"

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
  //
  // ⚠ THE SAME PARSER THE OUTBOUND SIGNER USES. Since 2026-09-04 both
  // directions speak Standard Webhooks, so two hand-written readers of this
  // header would be two chances for one to drift into accepting something the
  // other refuses.
  if (matchesAnySignature(expected, signature)) return { ok: true }

  return { ok: false, reason: "no matching signature" }
}
