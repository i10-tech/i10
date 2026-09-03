import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Proving a webhook came from Polar.
 *
 * ⚠ THIS ENDPOINT GRANTS PAID PLANS. Everything else in the repo that verifies
 * a signature is protecting data; this one is protecting revenue. A forged
 * `subscription.active` is a free Pro account for anyone who learns the URL,
 * and there is nothing downstream that would ever notice — the row looks
 * exactly like a real one. So nothing is parsed for meaning before this passes.
 *
 * ⚠ POLAR'S KEY DERIVATION IS NOT THE STANDARD WEBHOOKS ONE, AND A CORRECT
 * IMPLEMENTATION OF THE SPEC REJECTS EVERY REAL POLAR WEBHOOK. The spec says
 * the secret is `whsec_` followed by base64, and that the HMAC key is those
 * decoded bytes. Polar signs with the UTF-8 bytes of the WHOLE secret string,
 * `whsec_` prefix included — their own SDK reaches the same place by
 * base64-encoding the entire secret before handing it to the standardwebhooks
 * library, which then base64-decodes it straight back.
 *
 * Their docs say they intend to move to the spec key, and their SDK already
 * accepts either. So does this: both candidates are tried, which costs one
 * extra HMAC on a request that arrives a handful of times a day and means the
 * migration is not an outage nobody predicted.
 *
 * ⚠ AND THE SIGNED MATERIAL INCLUDES THE ID AND THE TIMESTAMP, so neither can
 * be edited by whoever relays the request. That is what makes the replay window
 * below enforceable at all.
 */

/** How far out of step a delivery's clock may be. Standard Webhooks' own advice. */
export const POLAR_TOLERANCE_SECONDS = 300

export interface PolarHeaders {
  id: string
  timestamp: string
  signature: string
}

export type VerifyResult =
  | { ok: true; id: string }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale" | "mismatch" }

/**
 * ⚠ TAKES THE RAW BODY, NOT A PARSED OBJECT. `JSON.parse` followed by
 * `JSON.stringify` is not the identity — key order, unicode escapes and number
 * formatting all move — so a signature checked against a re-serialised body
 * fails for reasons that look like a wrong secret. The route must read
 * `c.req.text()` and hand that exact string to both this and the parser.
 */
export function verifyPolarWebhook(
  body: string,
  headers: Partial<PolarHeaders>,
  secret: string,
  now: Date = new Date(),
  toleranceSeconds: number = POLAR_TOLERANCE_SECONDS,
): VerifyResult {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" }

  const t = Number(timestamp)
  if (!Number.isFinite(t)) return { ok: false, reason: "bad_timestamp" }

  // ⚠ BOTH DIRECTIONS. Refusing only old timestamps lets anyone with a forged
  // future timestamp mint something that stays acceptable for as long as they
  // chose — the window is a window, not a floor.
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) {
    return { ok: false, reason: "stale" }
  }

  const material = `${id}.${timestamp}.${body}`
  const expected = candidateKeys(secret).map((key) =>
    createHmac("sha256", key).update(material).digest("base64"),
  )

  // The header is a space-delimited list so a secret can be rotated without
  // downtime: during the overlap both signatures are sent and either verifies.
  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",")
    if (version !== "v1" || !value) continue
    if (expected.some((e) => equalDigests(e, value))) return { ok: true, id }
  }

  return { ok: false, reason: "mismatch" }
}

/**
 * Polar's key first, the spec's second.
 *
 * A secret with no `whsec_` prefix has only one candidate — base64-decoding an
 * arbitrary string does not throw, it silently produces garbage bytes, so the
 * second candidate is only offered when the prefix says the remainder is
 * meant to be base64.
 */
function candidateKeys(secret: string): Buffer[] {
  const keys = [Buffer.from(secret, "utf8")]
  if (secret.startsWith("whsec_")) {
    keys.push(Buffer.from(secret.slice("whsec_".length), "base64"))
  }
  return keys
}

/**
 * ⚠ CONSTANT TIME. `===` on a base64 digest returns at the first differing
 * character, and that timing is enough to recover a valid signature one
 * character at a time from an endpoint that answers quickly.
 */
function equalDigests(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(given, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}
